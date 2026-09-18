use std::sync::Arc;

use tauri::State;

use crate::error::{to_command_error, AppError};
use crate::models::{
    CancelShellConnectionInput, CloseShellInput, CommandExecutionResult, ExecuteCommandInput,
    FetchServerStatusInput, OpenShellInput, PtyResizeInput, PtyWriteInput, RunScriptInput,
    RunScriptResult, SftpCancelTransferInput, SftpCreateInput, SftpDeleteInput, SftpDownloadInput,
    SftpDownloadPayload, SftpDownloadToLocalInput, SftpFileContent, SftpListInput,
    ReopenShellPtyInput, SftpListResponse, SftpReadInput, SftpRenameInput, SftpTransferResult,
    SftpUploadInput,
    SftpUploadLocalWithProgressInput, SftpUploadWithProgressInput, SftpWriteInput, ShellSession,
    SshKiRespondInput,
};
use crate::state::AppState;

/// Returns all in-memory shell sessions (multi-tab shell support).
#[tauri::command]
pub fn list_shell_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<ShellSession>, String> {
    Ok(state.list_sessions())
}

/// Opens a new shell session for a selected SSH profile.
///
/// The underlying server_ops layer performs its own connection handshake and
/// spawns the long-lived PTY worker, so this command simply awaits it.
#[tauri::command]
pub async fn open_shell_session(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: OpenShellInput,
) -> Result<ShellSession, String> {
    let app_state = Arc::clone(state.inner());
    super::open_shell_session(
        app_state,
        app,
        &input.config_id,
        input.request_id.as_deref(),
    )
    .await
    .map_err(to_command_error)
}

/// Requests cancellation for a pending shell connection attempt.
#[tauri::command]
pub fn cancel_open_shell_session(
    state: State<'_, Arc<AppState>>,
    input: CancelShellConnectionInput,
) -> Result<bool, String> {
    Ok(state.cancel_shell_connection(&input.request_id))
}

/// Reopens the PTY channel of an existing shell session after its worker died.
///
/// The session id is preserved, so the tab, its working directory and its status
/// cache all survive the recovery.
#[tauri::command]
pub async fn reopen_shell_pty(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: ReopenShellPtyInput,
) -> Result<ShellSession, String> {
    let app_state = Arc::clone(state.inner());
    super::reopen_shell_pty(app_state, app, &input.session_id)
        .await
        .map_err(to_command_error)
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
    super::execute_command(&app_state, &input.session_id, &input.command)
        .await
        .map_err(to_command_error)
}

/// Browses one remote directory via SFTP.
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpListInput,
) -> Result<SftpListResponse, String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_list_dir(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Reads remote text file content for editor view.
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpReadInput,
) -> Result<SftpFileContent, String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_read_file(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Writes text editor content back to remote file through SFTP.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpWriteInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_write_file(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Creates an empty remote file through SFTP.
#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpCreateInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_create_file(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Creates one remote directory through SFTP.
#[tauri::command]
pub async fn sftp_create_directory(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpCreateInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_create_directory(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Uploads local file bytes (base64 payload) to a remote path via SFTP.
#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpUploadInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_upload_file(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Deletes one remote file or symlink via SFTP.
#[tauri::command]
pub async fn sftp_delete_entry(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpDeleteInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_delete_entry(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Renames one remote file, symlink, or directory via SFTP.
#[tauri::command]
pub async fn sftp_rename_entry(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpRenameInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_rename_entry(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Uploads local file bytes (base64 payload) and emits transfer progress events.
///
/// The transfer runs on a detached task so it keeps its own lifetime even if
/// the frontend cancels the await; the command still waits for the task and
/// reports a task failure as a command error.
#[tauri::command]
pub async fn sftp_upload_file_with_progress(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpUploadWithProgressInput,
) -> Result<SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        super::sftp_upload_file_with_progress(&app_state, &app, input).await
    })
    .await
    .map_err(|error| to_command_error(AppError::Runtime(error.to_string())))?
    .map_err(to_command_error)
}

/// Streams a local file path to a remote path and emits transfer progress events.
#[tauri::command]
pub async fn sftp_upload_local_file_with_progress(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpUploadLocalWithProgressInput,
) -> Result<SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        super::sftp_upload_local_file_with_progress(&app_state, &app, input).await
    })
    .await
    .map_err(|error| to_command_error(AppError::Runtime(error.to_string())))?
    .map_err(to_command_error)
}

/// Downloads remote file content via SFTP and returns base64 payload.
#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpDownloadInput,
) -> Result<SftpDownloadPayload, String> {
    let app_state = Arc::clone(state.inner());
    super::sftp_download_file(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// Downloads one remote file directly to a local directory with progress events.
#[tauri::command]
pub async fn sftp_download_file_to_local(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: SftpDownloadToLocalInput,
) -> Result<SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        super::sftp_download_file_to_local(&app_state, &app, input).await
    })
    .await
    .map_err(|error| to_command_error(AppError::Runtime(error.to_string())))?
    .map_err(to_command_error)
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
    app: tauri::AppHandle,
    input: FetchServerStatusInput,
) -> Result<crate::models::ServerStatus, String> {
    let app_state = Arc::clone(state.inner());
    super::fetch_server_status(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
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
    // Storage lookup is synchronous in-memory work; only the remote execution
    // is async, so it is awaited directly instead of being wrapped.
    let script = app_state
        .storage
        .find_script(&input.script_id)
        .map_err(to_command_error)?;
    let command = if script.command.trim().is_empty() {
        format!("bash {}", shell_quote(&script.path))
    } else {
        script.command.clone()
    };
    let execution = super::execute_command(&app_state, &input.session_id, &command)
        .await
        .map_err(to_command_error)?;
    Ok(RunScriptResult {
        script_id: script.id,
        script_name: script.name,
        execution,
    })
}

/// Delivers keyboard-interactive responses from the UI to the waiting SSH auth task.
#[tauri::command]
pub fn ssh_ki_respond(
    state: State<'_, Arc<AppState>>,
    input: SshKiRespondInput,
) -> Result<(), String> {
    super::ssh_ki_respond(&state, &input.request_id, input.responses).map_err(to_command_error)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
