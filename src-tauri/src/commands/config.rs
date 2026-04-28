use std::sync::Arc;

use tauri::State;

use crate::error::to_command_error;
use crate::models::{
    AgentContextContent, AgentContextInput, AiConfig, AiConfigInput, AiProfileInput,
    AiProfilesState, SaveAgentContextInput, ScriptDefinition, ScriptInput, SetActiveAiProfileInput,
    SetAiAgentModeInput, SetAiApprovalModeInput, SshConfig, SshConfigInput,
};
use crate::state::AppState;

/// Returns all stored SSH connection profiles.
#[tauri::command]
pub fn list_ssh_configs(state: State<'_, Arc<AppState>>) -> Result<Vec<SshConfig>, String> {
    Ok(state.storage.list_ssh_configs())
}

/// Creates or updates a single SSH connection profile.
#[tauri::command]
pub fn save_ssh_config(
    state: State<'_, Arc<AppState>>,
    input: SshConfigInput,
) -> Result<SshConfig, String> {
    state
        .storage
        .upsert_ssh_config(input)
        .map_err(to_command_error)
}

/// Deletes one SSH connection profile.
#[tauri::command]
pub fn delete_ssh_config(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state
        .storage
        .delete_ssh_config(&id)
        .map_err(to_command_error)
}

/// Lists all script definitions managed by user.
#[tauri::command]
pub fn list_scripts(state: State<'_, Arc<AppState>>) -> Result<Vec<ScriptDefinition>, String> {
    Ok(state.storage.list_scripts())
}

/// Creates or updates one script definition.
#[tauri::command]
pub fn save_script(
    state: State<'_, Arc<AppState>>,
    input: ScriptInput,
) -> Result<ScriptDefinition, String> {
    state.storage.upsert_script(input).map_err(to_command_error)
}

/// Deletes one script definition by id.
#[tauri::command]
pub fn delete_script(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_script(&id).map_err(to_command_error)
}

/// Returns AI provider configuration from persistent store.
#[tauri::command]
pub fn get_ai_config(state: State<'_, Arc<AppState>>) -> Result<AiConfig, String> {
    Ok(state.storage.get_ai_config())
}

/// Returns all persisted AI profiles and active profile id.
#[tauri::command]
pub fn list_ai_profiles(state: State<'_, Arc<AppState>>) -> Result<AiProfilesState, String> {
    Ok(state.storage.list_ai_profiles())
}

/// Creates or updates one AI profile.
#[tauri::command]
pub fn save_ai_profile(
    state: State<'_, Arc<AppState>>,
    input: AiProfileInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .save_ai_profile(input)
        .map_err(to_command_error)
}

/// Deletes one AI profile by id.
#[tauri::command]
pub fn delete_ai_profile(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .delete_ai_profile(&id)
        .map_err(to_command_error)
}

/// Saves the global approval mode shared by every AI profile.
#[tauri::command]
pub fn save_ai_approval_mode(
    state: State<'_, Arc<AppState>>,
    input: SetAiApprovalModeInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .save_ai_approval_mode(input.approval_mode)
        .map_err(to_command_error)
}

/// Saves the global agent runtime mode shared by every AI profile.
#[tauri::command]
pub fn save_ai_agent_mode(
    state: State<'_, Arc<AppState>>,
    input: SetAiAgentModeInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .save_ai_agent_mode(input.agent_mode)
        .map_err(to_command_error)
}

/// Reads global or per-server AGENTS.md content stored on the local client.
#[tauri::command]
pub fn get_agent_context(
    state: State<'_, Arc<AppState>>,
    input: AgentContextInput,
) -> Result<AgentContextContent, String> {
    state
        .storage
        .get_agent_context(input.server_id.as_deref())
        .map_err(to_command_error)
}

/// Saves global or per-server AGENTS.md content stored on the local client.
#[tauri::command]
pub fn save_agent_context(
    state: State<'_, Arc<AppState>>,
    input: SaveAgentContextInput,
) -> Result<AgentContextContent, String> {
    state
        .storage
        .save_agent_context(input.server_id.as_deref(), &input.content)
        .map_err(to_command_error)
}

/// Marks one AI profile as active for chat.
#[tauri::command]
pub fn set_active_ai_profile(
    state: State<'_, Arc<AppState>>,
    input: SetActiveAiProfileInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .set_active_ai_profile(&input.id)
        .map_err(to_command_error)
}

/// Saves AI provider configuration.
#[tauri::command]
pub fn save_ai_config(
    state: State<'_, Arc<AppState>>,
    input: AiConfigInput,
) -> Result<AiConfig, String> {
    state
        .storage
        .save_ai_config(input)
        .map_err(to_command_error)
}
