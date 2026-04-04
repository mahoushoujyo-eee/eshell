use std::sync::Arc;

use tauri::State;

use crate::error::to_command_error;
use crate::ops_agent::service as ops_agent_service;
use crate::ops_agent::types::{
    OpsAgentCancelRunInput, OpsAgentCancelRunResult, OpsAgentChatAccepted, OpsAgentChatInput,
    OpsAgentCompactConversationInput, OpsAgentCompactConversationResult, OpsAgentConversation,
    OpsAgentConversationSummary, OpsAgentCreateConversationInput,
    OpsAgentDeleteConversationInput, OpsAgentGetConversationInput, OpsAgentListPendingActionsInput,
    OpsAgentPendingAction, OpsAgentResolveActionInput, OpsAgentResolveActionResult,
    OpsAgentSetActiveConversationInput,
};
use crate::state::AppState;

/// Lists persisted OpsAgent conversations.
#[tauri::command]
pub fn ops_agent_list_conversations(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<OpsAgentConversationSummary>, String> {
    Ok(ops_agent_service::list_conversations(&state))
}

/// Creates one OpsAgent conversation.
#[tauri::command]
pub fn ops_agent_create_conversation(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentCreateConversationInput,
) -> Result<OpsAgentConversation, String> {
    ops_agent_service::create_conversation(
        &state,
        input.title.as_deref(),
        input.session_id.as_deref(),
    )
    .map_err(to_command_error)
}

/// Reads one OpsAgent conversation with full message history.
#[tauri::command]
pub fn ops_agent_get_conversation(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentGetConversationInput,
) -> Result<OpsAgentConversation, String> {
    ops_agent_service::get_conversation(&state, &input.conversation_id).map_err(to_command_error)
}

/// Deletes one OpsAgent conversation.
#[tauri::command]
pub fn ops_agent_delete_conversation(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentDeleteConversationInput,
) -> Result<(), String> {
    ops_agent_service::delete_conversation(&state, &input.conversation_id).map_err(to_command_error)
}

/// Marks one OpsAgent conversation as active.
#[tauri::command]
pub fn ops_agent_set_active_conversation(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentSetActiveConversationInput,
) -> Result<(), String> {
    ops_agent_service::set_active_conversation(&state, &input.conversation_id)
        .map_err(to_command_error)
}

/// Compacts one OpsAgent conversation history to reclaim context window.
#[tauri::command]
pub async fn ops_agent_compact_conversation(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentCompactConversationInput,
) -> Result<OpsAgentCompactConversationResult, String> {
    let app_state = Arc::clone(state.inner());
    ops_agent_service::compact_conversation(app_state, input)
        .await
        .map_err(to_command_error)
}

/// Starts one OpsAgent chat run and emits streaming chunks via `ops-agent-stream`.
#[tauri::command]
pub fn ops_agent_chat_stream_start(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: OpsAgentChatInput,
) -> Result<OpsAgentChatAccepted, String> {
    let app_state = Arc::clone(state.inner());
    ops_agent_service::start_chat_stream(app_state, app, input).map_err(to_command_error)
}

/// Lists pending/finished write-shell actions for approval UI.
#[tauri::command]
pub fn ops_agent_list_pending_actions(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentListPendingActionsInput,
) -> Result<Vec<OpsAgentPendingAction>, String> {
    Ok(ops_agent_service::list_pending_actions(
        &state,
        input.session_id.as_deref(),
        input.only_pending.unwrap_or(true),
    ))
}

/// Approves or rejects one pending write-shell action.
#[tauri::command]
pub async fn ops_agent_resolve_action(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: OpsAgentResolveActionInput,
) -> Result<OpsAgentResolveActionResult, String> {
    let app_state = Arc::clone(state.inner());
    ops_agent_service::resolve_pending_action(app_state, Some(app), input)
        .await
        .map_err(to_command_error)
}

/// Cancels one running OpsAgent chat stream by run id.
#[tauri::command]
pub fn ops_agent_cancel_run(
    state: State<'_, Arc<AppState>>,
    input: OpsAgentCancelRunInput,
) -> Result<OpsAgentCancelRunResult, String> {
    ops_agent_service::cancel_chat_run(&state, &input.run_id).map_err(to_command_error)
}
