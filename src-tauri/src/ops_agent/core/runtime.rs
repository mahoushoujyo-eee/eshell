use std::sync::Arc;

use tauri::AppHandle;

use crate::ops_agent::domain::types::OpsAgentMessage;
use crate::ops_agent::infrastructure::logging::{append_debug_log, resolve_ops_agent_log_path};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;
use super::helpers::is_run_cancelled_error;
use super::react_loop::process_chat_stream;
use super::ProcessChatOutcome;

pub(crate) fn spawn_chat_run_task(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    session_id: Option<String>,
    current_user_message_id: String,
    run_handle: OpsAgentRunHandle,
    seed_turn_tool_history: Vec<OpsAgentMessage>,
) {
    let state_for_task = Arc::clone(&state);
    let app_for_task = app.clone();
    let run_id_for_task = run_id.clone();
    let conversation_id_for_task = conversation_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = process_chat_stream(
            Arc::clone(&state_for_task),
            app_for_task.clone(),
            run_id_for_task.clone(),
            conversation_id_for_task.clone(),
            session_id,
            current_user_message_id,
            run_handle.clone(),
            seed_turn_tool_history,
        )
        .await;
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
            Ok(ProcessChatOutcome::Cancelled) => {
                append_debug_log(
                    state_for_task.as_ref(),
                    "chat.cancelled",
                    Some(run_id_for_task.as_str()),
                    Some(conversation_id_for_task.as_str()),
                    "run cancelled by user",
                );
                OpsAgentEventEmitter::new(
                    app_for_task,
                    resolve_ops_agent_log_path(&state_for_task.storage.data_dir()),
                    run_id_for_task,
                    conversation_id_for_task,
                )
                .completed(String::new(), None);
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
