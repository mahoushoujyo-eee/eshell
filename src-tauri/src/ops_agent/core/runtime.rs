use std::sync::Arc;

use tauri::AppHandle;

use super::helpers::is_run_cancelled_error;
use super::helpers::ensure_run_not_cancelled;
use super::ProcessChatOutcome;
use crate::models::AiAgentMode;
use crate::ops_agent::domain::types::{OpsAgentMessage, OpsAgentRole, OpsAgentRunResume};
use crate::ops_agent::infrastructure::logging::{append_debug_log, resolve_ops_agent_log_path};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;

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
    let effective_mode = resolve_effective_agent_mode(
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
        "chat.runtime.mode",
        Some(task.run_id.as_str()),
        Some(task.conversation_id.as_str()),
        format!("mode={:?}", effective_mode),
    );

    match effective_mode {
        AiAgentMode::Lite => {
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
        AiAgentMode::Pro | AiAgentMode::Auto => {
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

async fn resolve_effective_agent_mode(
    state: &AppState,
    run_id: &str,
    conversation_id: &str,
    current_user_message_id: &str,
    session_id: Option<&str>,
    run_handle: &OpsAgentRunHandle,
    resume: Option<&OpsAgentRunResume>,
) -> crate::error::AppResult<AiAgentMode> {
    let config = state.storage.get_ai_config();
    if resume.is_some() {
        return Ok(AiAgentMode::Pro);
    }
    if config.agent_mode != AiAgentMode::Auto {
        return Ok(config.agent_mode);
    }

    ensure_run_not_cancelled(run_handle)?;
    let (history, current_user_message) = load_route_context(state, conversation_id, current_user_message_id)?;
    let session_context = super::prompting::load_session_context(state, session_id);
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let (mode, reason) = super::llm::route_agent_mode(
        state,
        &config,
        &history,
        &current_user_message,
        &session_context,
        &tool_hints,
        Some(OpsAgentLogContext::new(
            state,
            Some(run_id),
            Some(conversation_id),
        )),
    )
    .await?;
    ensure_run_not_cancelled(run_handle)?;
    append_debug_log(
        state,
        "chat.runtime.auto_mode",
        Some(run_id),
        Some(conversation_id),
        format!("selected={:?} reason={reason}", mode),
    );
    Ok(mode)
}

fn load_route_context(
    state: &AppState,
    conversation_id: &str,
    current_user_message_id: &str,
) -> crate::error::AppResult<(Vec<OpsAgentMessage>, OpsAgentMessage)> {
    let conversation = state.ops_agent.get_conversation(conversation_id)?;
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
        conversation.messages.into_iter().take(current_index).collect(),
        current_message,
    ))
}
