use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::time::sleep;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::ops_agent::domain::types::{
    OpsAgentMessage, OpsAgentPendingAction, OpsAgentRole, OpsAgentToolCall,
    OpsAgentToolCallStatus, OpsAgentToolKind, PlannedAgentReply,
};
use crate::ops_agent::infrastructure::logging::{
    append_debug_log, resolve_ops_agent_log_path, OpsAgentLogContext,
};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::tools::OpsAgentToolOutcome;
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;

use super::helpers::{
    emit_static_reply, ensure_run_not_cancelled, is_run_cancelled_error, normalized_reply,
    truncate_for_log,
};
use super::{ProcessChatOutcome, OPS_AGENT_MAX_REACT_STEPS};

const OPS_AGENT_AI_MAX_RETRIES: usize = 3;
const OPS_AGENT_AI_RETRY_DELAY_SECS: u64 = 3;
const OPS_AGENT_AI_RETRY_SLEEP_SLICE_MS: u64 = 200;

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
    let emitter = OpsAgentEventEmitter::new(
        app,
        resolve_ops_agent_log_path(&state.storage.data_dir()),
        run_id,
        conversation_id.clone(),
    );
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
            Some(run_id_for_log.as_str()),
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
    if !seed_turn_tool_history.is_empty() {
        working_history.extend(seed_turn_tool_history);
    }
    let mut last_planner_reply = String::new();

    for step in 0..OPS_AGENT_MAX_REACT_STEPS {
        if run_handle.is_cancelled() {
            return Ok(ProcessChatOutcome::Cancelled);
        }

        let step_label = (step + 1).to_string();
        let plan = match request_plan_with_retry(
            state.as_ref(),
            &emitter,
            &run_handle,
            run_id_for_log.as_str(),
            conversation_id.as_str(),
            step_label.as_str(),
            &config,
            &working_history,
            &current_user_message,
            &session_context,
            &tool_hints,
        )
        .await
        {
            Ok(plan) => plan,
            Err(error) if is_run_cancelled_error(&error) => {
                return Ok(ProcessChatOutcome::Cancelled)
            }
            Err(error) if is_retryable_ai_error(&error) => {
                return finalize_chat_failure(
                    &state,
                    &conversation_id,
                    build_ai_retry_exhausted_message("规划", &error),
                    &emitter,
                );
            }
            Err(error) => return Err(error),
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
            let assistant_answer = match stream_answer_with_retry(
                state.as_ref(),
                &emitter,
                &run_handle,
                run_id_for_log.as_str(),
                conversation_id.as_str(),
                step_label.as_str(),
                "mode=planner_none",
                &config,
                &working_history,
                &current_user_message,
                &session_context,
                Some(plan.reply.as_str()),
            )
            .await
            {
                Ok(answer) => answer,
                Err(error) if is_run_cancelled_error(&error) => {
                    return Ok(ProcessChatOutcome::Cancelled)
                }
                Err(error) if is_retryable_ai_error(&error) => {
                    return finalize_chat_failure(
                        &state,
                        &conversation_id,
                        build_ai_retry_exhausted_message("回复", &error),
                        &emitter,
                    );
                }
                Err(error) => return Err(error),
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
        let command = if plan.tool.kind == OpsAgentToolKind::ui_context() {
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
        let tool_started_at = Instant::now();
        let outcome = tool
            .execute(crate::ops_agent::tools::OpsAgentToolRequest {
                state: Arc::clone(&state),
                conversation_id: conversation_id.clone(),
                current_user_message_id: Some(current_user_message.id.clone()),
                session_id: session_id.clone(),
                command: command.clone(),
                reason: tool_call_reason.clone(),
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
                    Vec::new(),
                )?;
                working_history.push(tool_message);

                let label = execution
                    .stream_label
                    .unwrap_or_else(|| format!("{} step {}", execution.tool_kind, step + 1));
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
                let approval_message = normalized_reply(
                    plan.reply,
                    "I created a command approval request in the chat. Review it before continuing.",
                );
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
    let assistant_answer = match stream_answer_with_retry(
        state.as_ref(),
        &emitter,
        &run_handle,
        run_id_for_log.as_str(),
        conversation_id.as_str(),
        "limit",
        "mode=step_limit",
        &config,
        &working_history,
        &current_user_message,
        &session_context,
        Some(planner_reply_on_limit.as_str()),
    )
    .await
    {
        Ok(answer) => answer,
        Err(error) if is_run_cancelled_error(&error) => return Ok(ProcessChatOutcome::Cancelled),
        Err(error) if is_retryable_ai_error(&error) => {
            return finalize_chat_failure(
                &state,
                &conversation_id,
                build_ai_retry_exhausted_message("回复", &error),
                &emitter,
            );
        }
        Err(error) => return Err(error),
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
        Vec::new(),
    )?;
    emitter.completed(assistant_answer, pending_action);
    Ok(ProcessChatOutcome::Completed)
}

fn finalize_chat_failure(
    state: &AppState,
    conversation_id: &str,
    assistant_message: String,
    emitter: &OpsAgentEventEmitter,
) -> AppResult<ProcessChatOutcome> {
    state.ops_agent.append_message(
        conversation_id,
        OpsAgentRole::Assistant,
        &assistant_message,
        None,
        None,
        Vec::new(),
    )?;
    emitter.completed(assistant_message, None);
    Ok(ProcessChatOutcome::Completed)
}

pub(crate) fn split_history_for_current_message(
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

async fn request_plan_with_retry(
    state: &AppState,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id_for_log: &str,
    conversation_id: &str,
    step_label: &str,
    config: &crate::models::AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &super::prompting::OpsAgentSessionContext,
    tool_hints: &[super::prompting::OpsAgentToolPromptHint],
) -> AppResult<PlannedAgentReply> {
    execute_ai_request_with_retry(
        state,
        emitter,
        run_handle,
        run_id_for_log,
        conversation_id,
        "react.plan",
        step_label,
        None,
        "规划",
        || {
            super::llm::plan_reply(
                state,
                config,
                history,
                current_message,
                session_context,
                tool_hints,
                Some(OpsAgentLogContext::new(
                    state,
                    Some(run_id_for_log),
                    Some(conversation_id),
                )),
            )
        },
    )
    .await
}

async fn stream_answer_with_retry(
    state: &AppState,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id_for_log: &str,
    conversation_id: &str,
    step_label: &str,
    mode_label: &str,
    config: &crate::models::AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &super::prompting::OpsAgentSessionContext,
    planner_reply: Option<&str>,
) -> AppResult<String> {
    execute_ai_request_with_retry(
        state,
        emitter,
        run_handle,
        run_id_for_log,
        conversation_id,
        "react.answer",
        step_label,
        Some(mode_label),
        "回复",
        || {
            super::llm::stream_final_answer(
                state,
                config,
                history,
                current_message,
                session_context,
                planner_reply,
                Some(OpsAgentLogContext::new(
                    state,
                    Some(run_id_for_log),
                    Some(conversation_id),
                )),
                |delta| {
                    ensure_run_not_cancelled(run_handle)?;
                    emitter.delta(delta.to_string());
                    Ok(())
                },
            )
        },
    )
    .await
}

async fn execute_ai_request_with_retry<T, F, Fut>(
    state: &AppState,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id_for_log: &str,
    conversation_id: &str,
    phase_log_prefix: &str,
    step_label: &str,
    mode_label: Option<&str>,
    user_phase_label: &str,
    mut operation: F,
) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    for attempt in 0..=OPS_AGENT_AI_MAX_RETRIES {
        ensure_run_not_cancelled(run_handle)?;

        let request_start_level = format!("{phase_log_prefix}.request_start");
        let request_started_at = Instant::now();
        let mut context_bits = vec![
            format!("step={step_label}"),
            format!("attempt={}/{}", attempt + 1, OPS_AGENT_AI_MAX_RETRIES + 1),
        ];
        if let Some(mode_label) = mode_label {
            context_bits.push(mode_label.to_string());
        }
        append_debug_log(
            state,
            request_start_level.as_str(),
            Some(run_id_for_log),
            Some(conversation_id),
            context_bits.join(" "),
        );

        match operation().await {
            Ok(value) => {
                let request_done_level = format!("{phase_log_prefix}.request_done");
                let mut done_bits = vec![
                    format!("step={step_label}"),
                    format!("attempt={}/{}", attempt + 1, OPS_AGENT_AI_MAX_RETRIES + 1),
                    format!("elapsed_ms={}", request_started_at.elapsed().as_millis()),
                ];
                if let Some(mode_label) = mode_label {
                    done_bits.push(mode_label.to_string());
                }
                append_debug_log(
                    state,
                    request_done_level.as_str(),
                    Some(run_id_for_log),
                    Some(conversation_id),
                    done_bits.join(" "),
                );
                return Ok(value);
            }
            Err(error) if is_run_cancelled_error(&error) => {
                let request_cancelled_level = format!("{phase_log_prefix}.request_cancelled");
                let mut cancelled_bits = vec![
                    format!("step={step_label}"),
                    format!("attempt={}/{}", attempt + 1, OPS_AGENT_AI_MAX_RETRIES + 1),
                    format!("elapsed_ms={}", request_started_at.elapsed().as_millis()),
                ];
                if let Some(mode_label) = mode_label {
                    cancelled_bits.push(mode_label.to_string());
                }
                append_debug_log(
                    state,
                    request_cancelled_level.as_str(),
                    Some(run_id_for_log),
                    Some(conversation_id),
                    cancelled_bits.join(" "),
                );
                return Err(error);
            }
            Err(error) => {
                let request_failed_level = format!("{phase_log_prefix}.request_failed");
                let mut failed_bits = vec![
                    format!("step={step_label}"),
                    format!("attempt={}/{}", attempt + 1, OPS_AGENT_AI_MAX_RETRIES + 1),
                    format!("elapsed_ms={}", request_started_at.elapsed().as_millis()),
                    format!("error={error}"),
                    format!("retryable={}", is_retryable_ai_error(&error)),
                ];
                if let Some(mode_label) = mode_label {
                    failed_bits.push(mode_label.to_string());
                }
                append_debug_log(
                    state,
                    request_failed_level.as_str(),
                    Some(run_id_for_log),
                    Some(conversation_id),
                    failed_bits.join(" "),
                );

                if !is_retryable_ai_error(&error) || attempt >= OPS_AGENT_AI_MAX_RETRIES {
                    return Err(error);
                }

                let retry_level = format!("{phase_log_prefix}.retry_scheduled");
                let mut retry_bits = vec![
                    format!("step={step_label}"),
                    format!("retry={}/{}", attempt + 1, OPS_AGENT_AI_MAX_RETRIES),
                    format!("wait_secs={OPS_AGENT_AI_RETRY_DELAY_SECS}"),
                ];
                if let Some(mode_label) = mode_label {
                    retry_bits.push(mode_label.to_string());
                }
                append_debug_log(
                    state,
                    retry_level.as_str(),
                    Some(run_id_for_log),
                    Some(conversation_id),
                    retry_bits.join(" "),
                );

                emitter.delta(build_ai_retry_notice(user_phase_label, attempt + 1, &error));
                wait_for_ai_retry_delay(run_handle).await?;
            }
        }
    }

    Err(AppError::Runtime(
        "AI retry loop exited unexpectedly".to_string(),
    ))
}

fn is_retryable_ai_error(error: &AppError) -> bool {
    match error {
        AppError::Reqwest(_) => true,
        AppError::Runtime(message) => {
            if let Some(status_code) = extract_status_code(message) {
                return status_code == 408
                    || status_code == 409
                    || status_code == 425
                    || status_code == 429
                    || status_code >= 500;
            }

            let normalized = message.to_ascii_lowercase();
            normalized.contains("timed out")
                || normalized.contains("timeout")
                || normalized.contains("connection reset")
                || normalized.contains("connection closed")
                || normalized.contains("error sending request")
                || normalized.contains("temporarily unavailable")
        }
        _ => false,
    }
}

fn extract_status_code(message: &str) -> Option<u16> {
    let marker = "status=";
    let start = message.find(marker)? + marker.len();
    let digits = message[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u16>().ok()
}

fn build_ai_retry_notice(user_phase_label: &str, retry_index: usize, error: &AppError) -> String {
    format!(
        "\n\n> 系统提示：AI {user_phase_label}请求失败，将在 {} 秒后自动重试（{retry_index}/{OPS_AGENT_AI_MAX_RETRIES}）。\n> 错误：{}\n\n",
        OPS_AGENT_AI_RETRY_DELAY_SECS,
        summarize_ai_error_for_user(error)
    )
}

fn build_ai_retry_exhausted_message(user_phase_label: &str, error: &AppError) -> String {
    format!(
        "AI {user_phase_label}请求已自动重试 {OPS_AGENT_AI_MAX_RETRIES} 次，仍未成功，现已停止重试。\n\n最后一次错误：{}\n\n建议稍后重试，或切换 AI 配置后再试。",
        summarize_ai_error_for_user(error)
    )
}

fn summarize_ai_error_for_user(error: &AppError) -> String {
    let collapsed = error
        .to_string()
        .replace('\n', " ")
        .replace('\r', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    truncate_for_log(collapsed.as_str(), 260)
}

async fn wait_for_ai_retry_delay(run_handle: &OpsAgentRunHandle) -> AppResult<()> {
    let total = Duration::from_secs(OPS_AGENT_AI_RETRY_DELAY_SECS);
    let slice = Duration::from_millis(OPS_AGENT_AI_RETRY_SLEEP_SLICE_MS);
    let mut elapsed = Duration::ZERO;

    while elapsed < total {
        ensure_run_not_cancelled(run_handle)?;
        let next_slice = std::cmp::min(slice, total.saturating_sub(elapsed));
        sleep(next_slice).await;
        elapsed += next_slice;
    }

    ensure_run_not_cancelled(run_handle)
}

#[cfg(test)]
mod retry_tests {
    use super::{extract_status_code, is_retryable_ai_error};
    use crate::error::AppError;

    #[test]
    fn extracts_status_codes_from_runtime_error_text() {
        assert_eq!(
            extract_status_code("ops agent AI request failed: status=500 Internal Server Error"),
            Some(500)
        );
        assert_eq!(
            extract_status_code("status=429 Too Many Requests"),
            Some(429)
        );
        assert_eq!(extract_status_code("no status here"), None);
    }

    #[test]
    fn retries_server_side_and_transport_failures() {
        assert!(is_retryable_ai_error(&AppError::Runtime(
            "ops agent AI request failed: status=500 Internal Server Error".to_string(),
        )));
        assert!(is_retryable_ai_error(&AppError::Runtime(
            "ops agent AI stream request failed: status=429 Too Many Requests".to_string(),
        )));
        assert!(!is_retryable_ai_error(&AppError::Runtime(
            "ops agent AI request failed: status=400 Bad Request".to_string(),
        )));
        assert!(!is_retryable_ai_error(&AppError::Validation(
            "apiKey cannot be empty".to_string(),
        )));
    }
}
