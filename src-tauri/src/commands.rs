use std::sync::Arc;

use tauri::State;

use crate::ai_service;
use crate::error::{to_command_error, AppError, AppResult};
use crate::models::{
    AiAnswer, AiAskInput, AiConfig, AiConfigInput, AiProfileInput, AiProfilesState,
    CloseShellInput, CommandExecutionResult, ExecuteCommandInput, FetchServerStatusInput,
    OpenShellInput, PtyResizeInput, PtyWriteInput, RunScriptInput, RunScriptResult, ScriptDefinition, ScriptInput,
    SetActiveAiProfileInput, SftpDownloadInput, SftpDownloadPayload, SftpFileContent, SftpListInput,
    SftpListResponse, SftpReadInput, SftpUploadInput, SftpWriteInput, ShellSession, SshConfig,
    SshConfigInput,
};
use crate::ops_agent::service as ops_agent_service;
use crate::ops_agent::types::{
    OpsAgentChatAccepted, OpsAgentChatInput, OpsAgentConversation, OpsAgentConversationSummary,
    OpsAgentCreateConversationInput, OpsAgentDeleteConversationInput, OpsAgentGetConversationInput,
    OpsAgentListPendingActionsInput, OpsAgentPendingAction, OpsAgentResolveActionInput,
    OpsAgentResolveActionResult, OpsAgentSetActiveConversationInput,
};
use crate::ssh_service;
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
pub fn delete_ssh_config(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.storage.delete_ssh_config(&id).map_err(to_command_error)
}

/// Returns all in-memory shell sessions (multi-tab shell support).
#[tauri::command]
pub fn list_shell_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<ShellSession>, String> {
    Ok(state.list_sessions())
}

/// Opens a new shell session for a selected SSH profile.
///
/// This command performs network IO and authentication, so we execute it
/// on a blocking worker thread to keep the async runtime responsive.
#[tauri::command]
pub async fn open_shell_session(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: OpenShellInput,
) -> Result<ShellSession, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::open_shell_session(app_state, app, &input.config_id)).await
}

/// Closes one shell session and drops the corresponding status cache.
#[tauri::command]
pub fn close_shell_session(
    state: State<'_, Arc<AppState>>,
    input: CloseShellInput,
) -> Result<(), String> {
    ssh_service::close_shell_session(&state, &input.session_id).map_err(to_command_error)
}

/// Sends raw PTY input for interactive shell.
#[tauri::command]
pub fn pty_write_input(
    state: State<'_, Arc<AppState>>,
    input: PtyWriteInput,
) -> Result<(), String> {
    ssh_service::pty_write_input(&state, &input.session_id, &input.data).map_err(to_command_error)
}

/// Resizes PTY viewport to keep remote interactive applications aligned.
#[tauri::command]
pub fn pty_resize(
    state: State<'_, Arc<AppState>>,
    input: PtyResizeInput,
) -> Result<(), String> {
    ssh_service::pty_resize(&state, &input.session_id, input.cols, input.rows).map_err(to_command_error)
}

/// Executes a terminal command in the selected shell tab.
///
/// The execution is isolated per session so different tabs do not overwrite
/// each other's working directory and terminal output cache.
#[tauri::command]
pub async fn execute_shell_command(
    state: State<'_, Arc<AppState>>,
    input: ExecuteCommandInput,
) -> Result<CommandExecutionResult, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::execute_command(&app_state, &input.session_id, &input.command))
        .await
}

/// Browses one remote directory via SFTP.
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, Arc<AppState>>,
    input: SftpListInput,
) -> Result<SftpListResponse, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::sftp_list_dir(&app_state, input)).await
}

/// Reads remote text file content for editor view.
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, Arc<AppState>>,
    input: SftpReadInput,
) -> Result<SftpFileContent, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::sftp_read_file(&app_state, input)).await
}

/// Writes text editor content back to remote file through SFTP.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Arc<AppState>>,
    input: SftpWriteInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::sftp_write_file(&app_state, input)).await
}

/// Uploads local file bytes (base64 payload) to a remote path via SFTP.
#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, Arc<AppState>>,
    input: SftpUploadInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::sftp_upload_file(&app_state, input)).await
}

/// Downloads remote file content via SFTP and returns base64 payload.
#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, Arc<AppState>>,
    input: SftpDownloadInput,
) -> Result<SftpDownloadPayload, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::sftp_download_file(&app_state, input)).await
}

/// Returns the current server runtime metrics (CPU/memory/network/process/disk).
#[tauri::command]
pub async fn fetch_server_status(
    state: State<'_, Arc<AppState>>,
    input: FetchServerStatusInput,
) -> Result<crate::models::ServerStatus, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || ssh_service::fetch_server_status(&app_state, input)).await
}

/// Returns cached metrics for instant UI render when switching tabs.
#[tauri::command]
pub fn get_cached_server_status(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Option<crate::models::ServerStatus>, String> {
    Ok(ssh_service::get_cached_server_status(&state, &session_id))
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
pub fn delete_script(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.storage.delete_script(&id).map_err(to_command_error)
}

/// Executes one saved script in selected shell tab.
///
/// Priority:
/// - If script.command is provided, execute it directly.
/// - Otherwise execute `bash <script.path>`.
#[tauri::command]
pub async fn run_script(
    state: State<'_, Arc<AppState>>,
    input: RunScriptInput,
) -> Result<RunScriptResult, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || {
        let script = app_state.storage.find_script(&input.script_id)?;
        let command = if script.command.trim().is_empty() {
            format!("bash {}", shell_quote(&script.path))
        } else {
            script.command.clone()
        };
        let execution = ssh_service::execute_command(&app_state, &input.session_id, &command)?;
        Ok(RunScriptResult {
            script_id: script.id,
            script_name: script.name,
            execution,
        })
    })
    .await
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
    state.storage.save_ai_profile(input).map_err(to_command_error)
}

/// Deletes one AI profile by id.
#[tauri::command]
pub fn delete_ai_profile(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<AiProfilesState, String> {
    state.storage.delete_ai_profile(&id).map_err(to_command_error)
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
    state.storage.save_ai_config(input).map_err(to_command_error)
}

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
    ops_agent_service::set_active_conversation(&state, &input.conversation_id).map_err(to_command_error)
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
    input: OpsAgentResolveActionInput,
) -> Result<OpsAgentResolveActionResult, String> {
    let app_state = Arc::clone(state.inner());
    ops_agent_service::resolve_pending_action(app_state, input)
        .await
        .map_err(to_command_error)
}

/// Sends question to configured OpenAI-compatible provider.
#[tauri::command]
pub async fn ai_ask(
    state: State<'_, Arc<AppState>>,
    input: AiAskInput,
) -> Result<AiAnswer, String> {
    ai_service::ask_ai(&state, input)
        .await
        .map_err(to_command_error)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn run_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| to_command_error(AppError::Runtime(error.to_string())))?
        .map_err(to_command_error)
}
