use std::sync::Arc;
use std::time::Instant;

use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::super::context::load_session_context;
use super::super::events::OpsAgentEventEmitter;
use super::super::logging::append_debug_log;
use super::super::openai;
use super::super::run_registry::OpsAgentRunHandle;
use super::super::tools::OpsAgentToolOutcome;
use super::super::types::{OpsAgentMessage, OpsAgentPendingAction, OpsAgentRole};
use super::helpers::{
    emit_static_reply, ensure_run_not_cancelled, is_run_cancelled_error, normalized_reply,
    truncate_for_log,
};
use super::{ProcessChatOutcome, OPS_AGENT_MAX_REACT_STEPS};

pub(super) async fn process_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    session_id: Option<String>,
    current_user_message_id: String,
    run_handle: OpsAgentRunHandle,
    seed_turn_tool_history: Vec<OpsAgentMessage>,
) -> AppResult<ProcessChatOutcome> {
    let run_id_for_log = run_id.clone();
    let emitter = OpsAgentEventEmitter::new(app, run_id, conversation_id.clone());
    emitter.started();
    append_debug_log(
        state.as_ref(),
        "run.started",
        Some(run_id_for_log.as_str()),
        Some(conversation_id.as_str()),
        format!(
            "session_id={} current_message_id={}",
            session_id.as_deref().unwrap_or("-"),
            current_user_message_id
        ),
    );
    if run_handle.is_cancelled() {
        return Ok(ProcessChatOutcome::Cancelled);
    }

    let config = state.storage.get_ai_config();
    let conversation = state.ops_agent.get_conversation(&conversation_id)?;
    let (history, current_user_message) =
        split_history_for_current_message(conversation.messages, &current_user_message_id)?;
    let session_context = load_session_context(&state, session_id.as_deref());
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let mut working_history = history;
    if !seed_turn_tool_history.is_empty() {
        working_history.extend(seed_turn_tool_history);
    }
    let mut last_planner_reply = String::new();

    for step in 0..OPS_AGENT_MAX_REACT_STEPS {
        if run_handle.is_cancelled() {
            return Ok(ProcessChatOutcome::Cancelled);
        }

        append_debug_log(
            state.as_ref(),
            "react.plan.request_start",
            Some(run_id_for_log.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "step={} history_messages={} user_message_id={}",
                step + 1,
                working_history.len(),
                current_user_message.id
            ),
        );
        let plan_started_at = Instant::now();
        let plan = openai::plan_reply(
            &config,
            &working_history,
            &current_user_message,
            &session_context,
            &tool_hints,
        )
        .await;
        let plan_elapsed_ms = plan_started_at.elapsed().as_millis();
        if run_handle.is_cancelled() {
            append_debug_log(
                state.as_ref(),
                "react.plan.request_cancelled",
                Some(run_id_for_log.as_str()),
                Some(conversation_id.as_str()),
                format!("step={} elapsed_ms={}", step + 1, plan_elapsed_ms),
            );
            return Ok(ProcessChatOutcome::Cancelled);
        }
        let plan = match plan {
            Ok(plan) => {
                append_debug_log(
                    state.as_ref(),
                    "react.plan.request_done",
                    Some(run_id_for_log.as_str()),
                    Some(conversation_id.as_str()),
                    format!(
                        "step={} elapsed_ms={} tool_candidates={}",
                        step + 1,
                        plan_elapsed_ms,
                        tool_hints.len()
                    ),
                );
                plan
            }
            Err(error) => {
                append_debug_log(
                    state.as_ref(),
                    "react.plan.request_failed",
                    Some(run_id_for_log.as_str()),
                    Some(conversation_id.as_str()),
                    format!(
                        "step={} elapsed_ms={} error={error}",
                        step + 1,
                        plan_elapsed_ms
                    ),
                );
                return Err(error);
            }
        };
        last_planner_reply = plan.reply.clone();
        append_debug_log(
            state.as_ref(),
            "react.plan",
            Some(run_id_for_log.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "step={} tool={} command={} reply={}",
                step + 1,
                plan.tool.kind,
                plan.tool.command.as_deref().unwrap_or("<none>"),
                truncate_for_log(plan.reply.as_str(), 200)
            ),
        );

        if plan.tool.kind.is_none() {
            append_debug_log(
                state.as_ref(),
                "react.answer.request_start",
                Some(run_id_for_log.as_str()),
                Some(conversation_id.as_str()),
                format!("step={} mode=planner_none", step + 1),
            );
            let answer_started_at = Instant::now();
            let assistant_answer = match stream_answer_with_fallback(
                &config,
                &working_history,
                &current_user_message,
                &session_context,
                Some(plan.reply.as_str()),
                &emitter,
                &run_handle,
            )
            .await
            {
                Ok(answer) => {
                    append_debug_log(
                        state.as_ref(),
                        "react.answer.request_done",
                        Some(run_id_for_log.as_str()),
                        Some(conversation_id.as_str()),
                        format!(
                            "step={} elapsed_ms={} answer_chars={}",
                            step + 1,
                            answer_started_at.elapsed().as_millis(),
                            answer.chars().count()
                        ),
                    );
                    answer
                }
                Err(error) if is_run_cancelled_error(&error) => {
                    append_debug_log(
                        state.as_ref(),
                        "react.answer.request_cancelled",
                        Some(run_id_for_log.as_str()),
                        Some(conversation_id.as_str()),
                        format!(
                            "step={} elapsed_ms={}",
                            step + 1,
                            answer_started_at.elapsed().as_millis()
                        ),
                    );
                    return Ok(ProcessChatOutcome::Cancelled);
                }
                Err(error) => {
                    append_debug_log(
                        state.as_ref(),
                        "react.answer.request_failed",
                        Some(run_id_for_log.as_str()),
                        Some(conversation_id.as_str()),
                        format!(
                            "step={} elapsed_ms={} error={error}",
                            step + 1,
                            answer_started_at.elapsed().as_millis()
                        ),
                    );
                    return Err(error);
                }
            };
            return finalize_chat_completion(
                &state,
                &conversation_id,
                assistant_answer,
                None,
                &emitter,
            );
        }

        let tool = state.ops_agent_tools.get(&plan.tool.kind).ok_or_else(|| {
            AppError::Validation(format!("tool {} is not registered", plan.tool.kind))
        })?;
        let command = if plan.tool.kind == super::super::types::OpsAgentToolKind::ui_context() {
            plan.tool.command.clone().unwrap_or_default()
        } else if let Some(command) = plan.tool.command.clone() {
            command
        } else {
            let assistant_answer = emit_static_reply(
                normalized_reply(
                    plan.reply,
                    &format!(
                        "Tool {} was selected without an executable command. Stopping here.",
                        plan.tool.kind
                    ),
                ),
                &emitter,
            );
            return finalize_chat_completion(
                &state,
                &conversation_id,
                assistant_answer,
                None,
                &emitter,
            );
        };

        if run_handle.is_cancelled() {
            return Ok(ProcessChatOutcome::Cancelled);
        }

        append_debug_log(
            state.as_ref(),
            "react.tool.request_start",
            Some(run_id_for_log.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "step={} tool={} command={}",
                step + 1,
                plan.tool.kind,
                command
            ),
        );
        let tool_started_at = Instant::now();
        let outcome = tool
            .execute(super::super::tools::OpsAgentToolRequest {
                state: Arc::clone(&state),
                conversation_id: conversation_id.clone(),
                current_user_message_id: Some(current_user_message.id.clone()),
                session_id: session_id.clone(),
                command: command.clone(),
                reason: plan.tool.reason.clone(),
            })
            .await;
        let tool_elapsed_ms = tool_started_at.elapsed().as_millis();
        let outcome = match outcome {
            Ok(outcome) => {
                append_debug_log(
                    state.as_ref(),
                    "react.tool.request_done",
                    Some(run_id_for_log.as_str()),
                    Some(conversation_id.as_str()),
                    format!(
                        "step={} tool={} command={} elapsed_ms={}",
                        step + 1,
                        plan.tool.kind,
                        command,
                        tool_elapsed_ms
                    ),
                );
                outcome
            }
            Err(error) => {
                append_debug_log(
                    state.as_ref(),
                    "react.tool_error",
                    Some(run_id_for_log.as_str()),
                    Some(conversation_id.as_str()),
                    format!(
                        "step={} tool={} command={} elapsed_ms={} error={error}",
                        step + 1,
                        plan.tool.kind,
                        command,
                        tool_elapsed_ms
                    ),
                );
                return Err(error);
            }
        };

        match outcome {
            OpsAgentToolOutcome::Executed(execution) => {
                if run_handle.is_cancelled() {
                    return Ok(ProcessChatOutcome::Cancelled);
                }

                let tool_message = state.ops_agent.append_message(
                    &conversation_id,
                    OpsAgentRole::Tool,
                    &execution.message,
                    Some(execution.tool_kind.clone()),
                    None,
                )?;
                working_history.push(tool_message);

                let label = execution
                    .stream_label
                    .unwrap_or_else(|| format!("{} step {}", execution.tool_kind, step + 1));
                emitter.tool_read(label);
            }
            OpsAgentToolOutcome::AwaitingApproval(action) => {
                if run_handle.is_cancelled() {
                    return Ok(ProcessChatOutcome::Cancelled);
                }
                append_debug_log(
                    state.as_ref(),
                    "react.tool.awaiting_approval",
                    Some(run_id_for_log.as_str()),
                    Some(conversation_id.as_str()),
                    format!(
                        "step={} action_id={} action_session_id={} run_session_id={} tool={} command={}",
                        step + 1,
                        action.id,
                        action.session_id.as_deref().unwrap_or("-"),
                        session_id.as_deref().unwrap_or("-"),
                        action.tool_kind,
                        action.command
                    ),
                );
                emitter.requires_approval(action.clone());
                let approval_message = if plan.reply.trim().is_empty() {
                    format!(
                        "Command `{}` needs approval before execution.\nReason: {}\nPlease approve or reject it in the UI.",
                        action.command, action.reason
                    )
                } else {
                    format!(
                        "{}\n\nCommand `{}` needs approval before execution.\nReason: {}\nPlease approve or reject it in the UI.",
                        plan.reply.trim(),
                        action.command,
                        action.reason
                    )
                };
                let assistant_answer = emit_static_reply(approval_message, &emitter);
                return finalize_chat_completion(
                    &state,
                    &conversation_id,
                    assistant_answer,
                    Some(action),
                    &emitter,
                );
            }
        }
    }

    let step_limit_hint =
        format!("I reached the autonomous tool step limit ({OPS_AGENT_MAX_REACT_STEPS}).");
    let planner_reply_on_limit = normalized_reply(last_planner_reply, &step_limit_hint);
    append_debug_log(
        state.as_ref(),
        "react.answer.request_start",
        Some(run_id_for_log.as_str()),
        Some(conversation_id.as_str()),
        "step=limit mode=step_limit".to_string(),
    );
    let answer_started_at = Instant::now();
    let assistant_answer = match stream_answer_with_fallback(
        &config,
        &working_history,
        &current_user_message,
        &session_context,
        Some(planner_reply_on_limit.as_str()),
        &emitter,
        &run_handle,
    )
    .await
    {
        Ok(answer) => {
            append_debug_log(
                state.as_ref(),
                "react.answer.request_done",
                Some(run_id_for_log.as_str()),
                Some(conversation_id.as_str()),
                format!(
                    "step=limit elapsed_ms={} answer_chars={}",
                    answer_started_at.elapsed().as_millis(),
                    answer.chars().count()
                ),
            );
            answer
        }
        Err(error) if is_run_cancelled_error(&error) => {
            append_debug_log(
                state.as_ref(),
                "react.answer.request_cancelled",
                Some(run_id_for_log.as_str()),
                Some(conversation_id.as_str()),
                format!(
                    "step=limit elapsed_ms={}",
                    answer_started_at.elapsed().as_millis()
                ),
            );
            return Ok(ProcessChatOutcome::Cancelled);
        }
        Err(error) => {
            append_debug_log(
                state.as_ref(),
                "react.answer.request_failed",
                Some(run_id_for_log.as_str()),
                Some(conversation_id.as_str()),
                format!(
                    "step=limit elapsed_ms={} error={error}",
                    answer_started_at.elapsed().as_millis()
                ),
            );
            return Err(error);
        }
    };

    finalize_chat_completion(&state, &conversation_id, assistant_answer, None, &emitter)
}

fn finalize_chat_completion(
    state: &AppState,
    conversation_id: &str,
    assistant_answer: String,
    pending_action: Option<OpsAgentPendingAction>,
    emitter: &OpsAgentEventEmitter,
) -> AppResult<ProcessChatOutcome> {
    state.ops_agent.append_message(
        conversation_id,
        OpsAgentRole::Assistant,
        &assistant_answer,
        None,
        None,
    )?;
    emitter.completed(assistant_answer, pending_action);
    Ok(ProcessChatOutcome::Completed)
}

pub(super) fn split_history_for_current_message(
    messages: Vec<OpsAgentMessage>,
    current_message_id: &str,
) -> AppResult<(Vec<OpsAgentMessage>, OpsAgentMessage)> {
    let current_index = messages
        .iter()
        .position(|item| item.id == current_message_id)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "ops agent message {current_message_id} for active chat run"
            ))
        })?;
    let current_message = messages[current_index].clone();
    if current_message.role != OpsAgentRole::User {
        return Err(AppError::Validation(
            "active chat run message must be a user message".to_string(),
        ));
    }

    let history = messages.into_iter().take(current_index).collect::<Vec<_>>();

    Ok((history, current_message))
}

async fn stream_answer_with_fallback(
    config: &crate::models::AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &super::super::context::OpsAgentSessionContext,
    planner_reply: Option<&str>,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
) -> AppResult<String> {
    match openai::stream_final_answer(
        config,
        history,
        current_message,
        session_context,
        planner_reply,
        |delta| {
            ensure_run_not_cancelled(run_handle)?;
            emitter.delta(delta.to_string());
            Ok(())
        },
    )
    .await
    {
        Ok(answer) => Ok(answer),
        Err(error) => {
            if is_run_cancelled_error(&error) {
                return Err(error);
            }
            let fallback = normalized_reply(
                planner_reply.unwrap_or_default().to_string(),
                "Received. I will help with this operations task.",
            );
            if fallback.trim().is_empty() {
                return Err(error);
            }
            Ok(emit_static_reply(fallback, emitter))
        }
    }
}
