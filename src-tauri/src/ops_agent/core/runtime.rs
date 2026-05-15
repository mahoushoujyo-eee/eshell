use std::sync::Arc;

use tauri::AppHandle;

use super::helpers::ensure_run_not_cancelled;
use super::helpers::is_run_cancelled_error;
use super::ProcessChatOutcome;
use crate::models::AiAgentMode;
use crate::ops_agent::domain::types::{OpsAgentMessage, OpsAgentRole, OpsAgentRunResume};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;
use crate::ops_agent::infrastructure::logging::{append_debug_log, resolve_ops_agent_log_path};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;

enum EffectiveChatRoute {
    DirectReply { answer: String, reason: String },
    Mode { mode: AiAgentMode, reason: String },
}

pub(crate) struct OpsAgentChatRunTask {
    pub state: Arc<AppState>,
    pub app: AppHandle,
    pub run_id: String,
    pub conversation_id: String,
    pub session_id: Option<String>,
    pub current_user_message_id: String,
    pub run_handle: OpsAgentRunHandle,
    pub resume: Option<OpsAgentRunResume>,
}

pub(crate) fn spawn_chat_run_task(task: OpsAgentChatRunTask) {
    let state_for_task = Arc::clone(&task.state);
    let app_for_task = task.app.clone();
    let run_id_for_task = task.run_id.clone();
    let conversation_id_for_task = task.conversation_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_chat_task(Arc::clone(&state_for_task), app_for_task.clone(), task).await;
        state_for_task.ops_agent_runs.finish(&run_id_for_task);

        match result {
            Ok(ProcessChatOutcome::Completed) => {
                append_debug_log(
                    state_for_task.as_ref(),
                    "chat.completed",
                    Some(run_id_for_task.as_str()),
                    Some(conversation_id_for_task.as_str()),
                    "stream finished",
                );
            }
            Err(error) => {
                append_debug_log(
                    state_for_task.as_ref(),
                    "chat.error",
                    Some(run_id_for_task.as_str()),
                    Some(conversation_id_for_task.as_str()),
                    error.to_string(),
                );
                if is_run_cancelled_error(&error) {
                    OpsAgentEventEmitter::new(
                        app_for_task,
                        resolve_ops_agent_log_path(&state_for_task.storage.data_dir()),
                        run_id_for_task,
                        conversation_id_for_task,
                    )
                    .completed(String::new(), None);
                    return;
                }
                OpsAgentEventEmitter::new(
                    app_for_task,
                    resolve_ops_agent_log_path(&state_for_task.storage.data_dir()),
                    run_id_for_task,
                    conversation_id_for_task,
                )
                .error(error.to_string());
            }
        }
    });
}

async fn run_chat_task(
    state: Arc<AppState>,
    app: AppHandle,
    task: OpsAgentChatRunTask,
) -> crate::error::AppResult<ProcessChatOutcome> {
    let effective_route = resolve_effective_chat_route(
        state.as_ref(),
        &task.run_id,
        &task.conversation_id,
        &task.current_user_message_id,
        task.session_id.as_deref(),
        &task.run_handle,
        task.resume.as_ref(),
    )
    .await?;

    append_debug_log(
        state.as_ref(),
        "chat.runtime.route",
        Some(task.run_id.as_str()),
        Some(task.conversation_id.as_str()),
        describe_effective_route(&effective_route),
    );

    match effective_route {
        EffectiveChatRoute::DirectReply { answer, reason } => complete_direct_reply(
            state,
            app,
            task.run_id,
            task.conversation_id,
            answer,
            reason,
        ),
        EffectiveChatRoute::Mode {
            mode: AiAgentMode::Lite,
            ..
        } => {
            super::react_loop::process_chat_stream(
                state,
                app,
                task.run_id,
                task.conversation_id,
                task.session_id,
                task.current_user_message_id,
                task.run_handle,
            )
            .await
        }
        EffectiveChatRoute::Mode {
            mode: AiAgentMode::Pro | AiAgentMode::Auto,
            ..
        } => {
            super::orchestrator::process_chat_stream(
                state,
                app,
                task.run_id,
                task.conversation_id,
                task.session_id,
                task.current_user_message_id,
                task.run_handle,
                task.resume,
            )
            .await
        }
    }
}

async fn resolve_effective_chat_route(
    state: &AppState,
    run_id: &str,
    conversation_id: &str,
    current_user_message_id: &str,
    session_id: Option<&str>,
    run_handle: &OpsAgentRunHandle,
    resume: Option<&OpsAgentRunResume>,
) -> crate::error::AppResult<EffectiveChatRoute> {
    let config = state.storage.get_ai_config();
    ensure_run_not_cancelled(run_handle)?;
    if let Some(compaction) = super::compaction::auto_compact_conversation_if_needed(
        state,
        conversation_id,
        session_id,
        &config,
    )
    .await?
    {
        append_debug_log(
            state,
            "chat.runtime.auto_compact",
            Some(run_id),
            Some(conversation_id),
            format!(
                "estimated_before={} estimated_after={}",
                compaction.estimated_tokens_before, compaction.estimated_tokens_after
            ),
        );
    }
    if resume.is_some() {
        return Ok(EffectiveChatRoute::Mode {
            mode: AiAgentMode::Pro,
            reason: "Resuming an interrupted executor run.".to_string(),
        });
    }

    let (history, current_user_message) = load_route_context(
        state,
        &config,
        session_id,
        conversation_id,
        current_user_message_id,
    )?;
    let session_context = super::prompting::load_session_context(state, session_id);
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let log_context = Some(OpsAgentLogContext::new(
        state,
        Some(run_id),
        Some(conversation_id),
    ));

    let route = if config.agent_mode == AiAgentMode::Auto {
        match super::llm::route_agent_mode(
            state,
            &config,
            &history,
            &current_user_message,
            &session_context,
            &tool_hints,
            log_context,
        )
        .await?
        {
            super::llm::OpsAgentRuntimeRoute::DirectReply { answer, reason } => {
                EffectiveChatRoute::DirectReply { answer, reason }
            }
            super::llm::OpsAgentRuntimeRoute::Lite { reason } => EffectiveChatRoute::Mode {
                mode: AiAgentMode::Lite,
                reason,
            },
            super::llm::OpsAgentRuntimeRoute::Pro { reason } => EffectiveChatRoute::Mode {
                mode: AiAgentMode::Pro,
                reason,
            },
        }
    } else {
        match super::llm::route_chat(
            state,
            &config,
            &history,
            &current_user_message,
            &session_context,
            &tool_hints,
            log_context,
        )
        .await?
        {
            super::llm::OpsAgentChatRoute::DirectReply { answer, reason } => {
                EffectiveChatRoute::DirectReply { answer, reason }
            }
            super::llm::OpsAgentChatRoute::Workflow { reason } => EffectiveChatRoute::Mode {
                mode: config.agent_mode,
                reason,
            },
        }
    };

    ensure_run_not_cancelled(run_handle)?;
    append_debug_log(
        state,
        "chat.runtime.gateway",
        Some(run_id),
        Some(conversation_id),
        describe_effective_route(&route),
    );
    Ok(route)
}

fn complete_direct_reply(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    answer: String,
    reason: String,
) -> crate::error::AppResult<ProcessChatOutcome> {
    let emitter = OpsAgentEventEmitter::new(
        app,
        resolve_ops_agent_log_path(&state.storage.data_dir()),
        run_id.clone(),
        conversation_id.clone(),
    );
    emitter.started();
    append_debug_log(
        state.as_ref(),
        "chat.runtime.direct_reply",
        Some(run_id.as_str()),
        Some(conversation_id.as_str()),
        format!("reason={reason} answer_chars={}", answer.chars().count()),
    );
    emitter.delta(answer.clone());
    state.ops_agent.append_message(
        &conversation_id,
        OpsAgentRole::Assistant,
        &answer,
        None,
        None,
        Vec::new(),
    )?;
    emitter.completed(answer, None);
    Ok(ProcessChatOutcome::Completed)
}

fn describe_effective_route(route: &EffectiveChatRoute) -> String {
    match route {
        EffectiveChatRoute::DirectReply { answer, reason } => format!(
            "route=direct_reply reason={} answer_chars={}",
            reason,
            answer.chars().count()
        ),
        EffectiveChatRoute::Mode { mode, reason } => {
            format!("route=mode mode={:?} reason={}", mode, reason)
        }
    }
}

fn load_route_context(
    state: &AppState,
    config: &crate::models::AiConfig,
    session_id: Option<&str>,
    conversation_id: &str,
    current_user_message_id: &str,
) -> crate::error::AppResult<(Vec<OpsAgentMessage>, OpsAgentMessage)> {
    let conversation = state.ops_agent.get_conversation(conversation_id)?;
    let conversation = super::compaction::model_conversation_for_current_message(
        state,
        conversation,
        current_user_message_id,
        session_id,
        config,
    )?;
    let current_index = conversation
        .messages
        .iter()
        .position(|item| item.id == current_user_message_id)
        .ok_or_else(|| {
            crate::error::AppError::NotFound(format!(
                "ops agent message {current_user_message_id} for runtime routing"
            ))
        })?;
    let current_message = conversation.messages[current_index].clone();
    if current_message.role != OpsAgentRole::User {
        return Err(crate::error::AppError::Validation(
            "runtime routing source message must be a user message".to_string(),
        ));
    }
    Ok((
        conversation
            .messages
            .into_iter()
            .take(current_index)
            .collect(),
        current_message,
    ))
}
