use std::sync::Arc;
use std::time::Instant;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::ops_agent::domain::types::{
    OpsAgentMessage, OpsAgentPendingAction, OpsAgentRole, OpsAgentToolCall,
    OpsAgentToolCallStatus, OpsAgentToolKind,
};
use crate::ops_agent::infrastructure::logging::{
    append_debug_log, resolve_ops_agent_log_path, OpsAgentLogContext,
};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::tools::{OpsAgentToolOutcome, OpsAgentToolRequest};
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;

use super::helpers::{ensure_run_not_cancelled, truncate_for_log};
use super::ProcessChatOutcome;

pub(crate) async fn process_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    session_id: Option<String>,
    current_user_message_id: String,
    run_handle: OpsAgentRunHandle,
) -> AppResult<ProcessChatOutcome> {
    let emitter = OpsAgentEventEmitter::new(
        app,
        resolve_ops_agent_log_path(&state.storage.data_dir()),
        run_id.clone(),
        conversation_id.clone(),
    );
    emitter.started();
    append_debug_log(
        state.as_ref(),
        "react.run.started",
        Some(run_id.as_str()),
        Some(conversation_id.as_str()),
        format!(
            "session_id={} current_message_id={}",
            session_id.as_deref().unwrap_or("-"),
            current_user_message_id
        ),
    );
    ensure_run_not_cancelled(&run_handle)?;

    let config = state.storage.get_ai_config();
    if let Some(compaction) = super::compaction::auto_compact_conversation_if_needed(
        state.as_ref(),
        &conversation_id,
        session_id.as_deref(),
        &config,
    )
    .await?
    {
        append_debug_log(
            state.as_ref(),
            "react.auto_compact",
            Some(run_id.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "estimated_before={} estimated_after={}",
                compaction.estimated_tokens_before, compaction.estimated_tokens_after
            ),
        );
    }

    let conversation = state.ops_agent.get_conversation(&conversation_id)?;
    let (history, current_user_message) =
        split_history_for_current_message(conversation.messages, &current_user_message_id)?;
    let session_context = super::prompting::load_session_context(&state, session_id.as_deref());
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let mut working_history = history;
    let mut last_planner_reply = String::new();

    for step in 0..super::OPS_AGENT_MAX_REACT_STEPS {
        ensure_run_not_cancelled(&run_handle)?;
        let step_number = step + 1;
        let plan = super::llm::plan_reply(
            state.as_ref(),
            &config,
            &working_history,
            &current_user_message,
            &session_context,
            &tool_hints,
            Some(OpsAgentLogContext::new(
                state.as_ref(),
                Some(run_id.as_str()),
                Some(conversation_id.as_str()),
            )),
        )
        .await?;
        last_planner_reply = plan.reply.clone();
        append_debug_log(
            state.as_ref(),
            "react.plan",
            Some(run_id.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "step={} tool={} command={} reply={}",
                step_number,
                plan.tool.kind,
                plan.tool.command.as_deref().unwrap_or("<none>"),
                truncate_for_log(plan.reply.as_str(), 200)
            ),
        );

        if plan.tool.kind.is_none() {
            let answer = stream_answer(
                state.as_ref(),
                &emitter,
                &run_handle,
                &run_id,
                &conversation_id,
                &config,
                &working_history,
                &current_user_message,
                &session_context,
                Some(plan.reply.as_str()),
            )
            .await?;
            return finalize_chat_completion(&state, &conversation_id, answer, None, &emitter);
        }

        let tool = state.ops_agent_tools.get(&plan.tool.kind).ok_or_else(|| {
            AppError::Validation(format!("tool {} is not registered", plan.tool.kind))
        })?;
        let command = if plan.tool.kind == OpsAgentToolKind::ui_context() {
            plan.tool.command.clone().unwrap_or_default()
        } else if let Some(command) = plan.tool.command.clone() {
            command
        } else {
            let answer = emit_static_reply(
                normalized_reply(
                    plan.reply,
                    &format!(
                        "Tool {} was selected without an executable command. Stopping here.",
                        plan.tool.kind
                    ),
                ),
                &emitter,
            );
            return finalize_chat_completion(&state, &conversation_id, answer, None, &emitter);
        };

        let tool_call_id = Uuid::new_v4().to_string();
        let tool_call_reason = plan.tool.reason.clone();
        emitter.tool_call(OpsAgentToolCall {
            id: tool_call_id.clone(),
            tool_kind: plan.tool.kind.clone(),
            command: command.clone(),
            reason: tool_call_reason.clone(),
            status: OpsAgentToolCallStatus::Requested,
            label: None,
        });

        let started_at = Instant::now();
        let outcome = tool
            .execute(OpsAgentToolRequest {
                state: Arc::clone(&state),
                conversation_id: conversation_id.clone(),
                current_user_message_id: Some(current_user_message.id.clone()),
                session_id: session_id.clone(),
                command: command.clone(),
                reason: tool_call_reason.clone(),
            })
            .await?;
        append_debug_log(
            state.as_ref(),
            "react.tool.request_done",
            Some(run_id.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "step={} tool={} command={} elapsed_ms={}",
                step_number,
                plan.tool.kind,
                command,
                started_at.elapsed().as_millis()
            ),
        );

        match outcome {
            OpsAgentToolOutcome::Executed(execution) => {
                ensure_run_not_cancelled(&run_handle)?;
                let tool_message = state.ops_agent.append_message(
                    &conversation_id,
                    OpsAgentRole::Tool,
                    &execution.message,
                    Some(execution.tool_kind.clone()),
                    None,
                    Vec::new(),
                )?;
                working_history.push(tool_message);

                let label = execution
                    .stream_label
                    .unwrap_or_else(|| format!("{} step {}", execution.tool_kind, step_number));
                emitter.tool_read(
                    label.clone(),
                    Some(OpsAgentToolCall {
                        id: tool_call_id,
                        tool_kind: execution.tool_kind,
                        command,
                        reason: tool_call_reason,
                        status: OpsAgentToolCallStatus::Executed,
                        label: Some(label),
                    }),
                );
            }
            OpsAgentToolOutcome::AwaitingApproval(action) => {
                ensure_run_not_cancelled(&run_handle)?;
                emitter.requires_approval(
                    action.clone(),
                    Some(OpsAgentToolCall {
                        id: tool_call_id,
                        tool_kind: action.tool_kind.clone(),
                        command: action.command.clone(),
                        reason: Some(action.reason.clone()),
                        status: OpsAgentToolCallStatus::AwaitingApproval,
                        label: Some("awaiting approval".to_string()),
                    }),
                );
                let answer = emit_static_reply(
                    normalized_reply(
                        plan.reply,
                        "I created a command approval request in the chat. Review it before continuing.",
                    ),
                    &emitter,
                );
                return finalize_chat_completion(
                    &state,
                    &conversation_id,
                    answer,
                    Some(action),
                    &emitter,
                );
            }
        }
    }

    let step_limit_hint = format!(
        "I reached the autonomous tool step limit ({}).",
        super::OPS_AGENT_MAX_REACT_STEPS
    );
    let planner_reply_on_limit = normalized_reply(last_planner_reply, &step_limit_hint);
    let answer = stream_answer(
        state.as_ref(),
        &emitter,
        &run_handle,
        &run_id,
        &conversation_id,
        &config,
        &working_history,
        &current_user_message,
        &session_context,
        Some(planner_reply_on_limit.as_str()),
    )
    .await?;
    finalize_chat_completion(&state, &conversation_id, answer, None, &emitter)
}

async fn stream_answer(
    state: &AppState,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    config: &crate::models::AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &super::prompting::OpsAgentSessionContext,
    planner_reply: Option<&str>,
) -> AppResult<String> {
    super::llm::stream_final_answer(
        state,
        config,
        history,
        current_message,
        session_context,
        planner_reply,
        Some(OpsAgentLogContext::new(
            state,
            Some(run_id),
            Some(conversation_id),
        )),
        |delta| {
            ensure_run_not_cancelled(run_handle)?;
            emitter.delta(delta.to_string());
            Ok(())
        },
    )
    .await
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
        Vec::new(),
    )?;
    emitter.completed(assistant_answer, pending_action);
    Ok(ProcessChatOutcome::Completed)
}

fn split_history_for_current_message(
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

fn normalized_reply(reply: String, fallback: &str) -> String {
    if reply.trim().is_empty() {
        fallback.to_string()
    } else {
        reply
    }
}

fn emit_static_reply(reply: String, emitter: &OpsAgentEventEmitter) -> String {
    if !reply.is_empty() {
        emitter.delta(reply.clone());
    }
    reply
}
