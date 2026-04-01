use std::sync::Arc;

use tauri::State;

use crate::error::{to_command_error, AppError, AppResult};
use crate::models::{
    CloseShellInput, CommandExecutionResult, ExecuteCommandInput, FetchServerStatusInput,
    OpenShellInput, PtyResizeInput, PtyWriteInput, RunScriptInput, RunScriptResult,
    SftpCancelTransferInput, SftpDownloadInput, SftpDownloadPayload, SftpDownloadToLocalInput,
    SftpFileContent, SftpListInput, SftpListResponse, SftpReadInput, SftpTransferResult,
    SftpUploadInput, SftpUploadWithProgressInput, SftpWriteInput, ShellSession,
};
use crate::state::AppState;

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
    run_blocking(move || super::open_shell_session(app_state, app, &input.config_id)).await
}

/// Closes one shell session and drops the corresponding status cache.
#[tauri::command]
pub fn close_shell_session(
    state: State<'_, Arc<AppState>>,
    input: CloseShellInput,
) -> Result<(), String> {
    super::close_shell_session(&state, &input.session_id).map_err(to_command_error)
}

/// Sends raw PTY input for interactive shell.
#[tauri::command]
pub fn pty_write_input(
    state: State<'_, Arc<AppState>>,
    input: PtyWriteInput,
) -> Result<(), String> {
    super::pty_write_input(&state, &input.session_id, &input.data).map_err(to_command_error)
}

/// Resizes PTY viewport to keep remote interactive applications aligned.
#[tauri::command]
pub fn pty_resize(state: State<'_, Arc<AppState>>, input: PtyResizeInput) -> Result<(), String> {
    super::pty_resize(&state, &input.session_id, input.cols, input.rows).map_err(to_command_error)
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
    run_blocking(move || super::execute_command(&app_state, &input.session_id, &input.command))
        .await
}

/// Browses one remote directory via SFTP.
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, Arc<AppState>>,
    input: SftpListInput,
) -> Result<SftpListResponse, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_list_dir(&app_state, input)).await
}

/// Reads remote text file content for editor view.
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, Arc<AppState>>,
    input: SftpReadInput,
) -> Result<SftpFileContent, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_read_file(&app_state, input)).await
}

/// Writes text editor content back to remote file through SFTP.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Arc<AppState>>,
    input: SftpWriteInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_write_file(&app_state, input)).await
}

/// Uploads local file bytes (base64 payload) to a remote path via SFTP.
#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, Arc<AppState>>,
    input: SftpUploadInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_upload_file(&app_state, input)).await
}

/// Uploads local file bytes (base64 payload) and emits transfer progress events.
#[tauri::command]
pub async fn sftp_upload_file_with_progress(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpUploadWithProgressInput,
) -> Result<SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_upload_file_with_progress(&app_state, &app, input)).await
}

/// Downloads remote file content via SFTP and returns base64 payload.
#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, Arc<AppState>>,
    input: SftpDownloadInput,
) -> Result<SftpDownloadPayload, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_download_file(&app_state, input)).await
}

/// Downloads one remote file directly to a local directory with progress events.
#[tauri::command]
pub async fn sftp_download_file_to_local(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpDownloadToLocalInput,
) -> Result<SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::sftp_download_file_to_local(&app_state, &app, input)).await
}

/// Returns default local download directory for current OS.
#[tauri::command]
pub fn sftp_default_download_dir() -> Result<String, String> {
    Ok(super::default_download_dir())
}

/// Requests cancellation for a running transfer task.
#[tauri::command]
pub fn sftp_cancel_transfer(
    state: State<'_, Arc<AppState>>,
    input: SftpCancelTransferInput,
) -> Result<bool, String> {
    Ok(super::sftp_cancel_transfer(&state, &input.transfer_id))
}

/// Returns the current server runtime metrics (CPU/memory/network/process/disk).
#[tauri::command]
pub async fn fetch_server_status(
    state: State<'_, Arc<AppState>>,
    input: FetchServerStatusInput,
) -> Result<crate::models::ServerStatus, String> {
    let app_state = Arc::clone(state.inner());
    run_blocking(move || super::fetch_server_status(&app_state, input)).await
}

/// Returns cached metrics for instant UI render when switching tabs.
#[tauri::command]
pub fn get_cached_server_status(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Option<crate::models::ServerStatus>, String> {
    Ok(super::get_cached_server_status(&state, &session_id))
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
        let execution = super::execute_command(&app_state, &input.session_id, &command)?;
        Ok(RunScriptResult {
            script_id: script.id,
            script_name: script.name,
            execution,
        })
    })
    .await
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
