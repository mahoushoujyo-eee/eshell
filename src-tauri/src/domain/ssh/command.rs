//! Tauri command surface for the SSH domain: shell sessions, PTY I/O,
//! non-interactive command execution and keyboard-interactive auth.
//!
//! Thin adapters over [`crate::domain::ssh::service`]: decode the command
//! input, run the service call, flatten errors to strings.

use std::sync::Arc;

use tauri::State;

use crate::common::error::to_command_error;
use crate::domain::ssh::model::session_model::ShellSession;
use crate::domain::ssh::model::SshKiRespondInput;
use crate::domain::ssh::model::session_model::{
    CancelShellConnectionInput, CloseShellInput, CommandExecutionResult, ExecuteCommandInput,
    OpenShellInput, PtyResizeInput, PtyWriteInput, ReopenShellPtyInput,
};
use crate::state::AppState;

/// Returns all in-memory shell sessions (multi-tab shell support).
#[tauri::command]
pub fn list_shell_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<ShellSession>, String> {
    Ok(state.list_sessions())
}

/// Opens a new shell session for a selected SSH profile.
///
/// The underlying service layer performs its own connection handshake and
/// spawns the long-lived PTY worker, so this command simply awaits it.
#[tauri::command]
pub async fn open_shell_session(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: OpenShellInput,
) -> Result<ShellSession, String> {
    let app_state = Arc::clone(state.inner());
    super::service::open_shell_session(
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
    super::service::reopen_shell_pty(app_state, app, &input.session_id)
        .await
        .map_err(to_command_error)
}

/// Closes one shell session and drops the corresponding status cache.
#[tauri::command]
pub fn close_shell_session(
    state: State<'_, Arc<AppState>>,
    input: CloseShellInput,
) -> Result<(), String> {
    super::service::close_shell_session(&state, &input.session_id).map_err(to_command_error)
}

/// Sends raw PTY input for interactive shell.
#[tauri::command]
pub fn pty_write_input(
    state: State<'_, Arc<AppState>>,
    input: PtyWriteInput,
) -> Result<(), String> {
    super::service::pty_write_input(&state, &input.session_id, &input.data).map_err(to_command_error)
}

/// Resizes PTY viewport to keep remote interactive applications aligned.
#[tauri::command]
pub fn pty_resize(state: State<'_, Arc<AppState>>, input: PtyResizeInput) -> Result<(), String> {
    super::service::pty_resize(&state, &input.session_id, input.cols, input.rows)
        .map_err(to_command_error)
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
    super::service::execute_command(&app_state, &input.session_id, &input.command)
        .await
        .map_err(to_command_error)
}

/// Delivers keyboard-interactive responses from the UI to the waiting SSH auth task.
#[tauri::command]
pub fn ssh_ki_respond(
    state: State<'_, Arc<AppState>>,
    input: SshKiRespondInput,
) -> Result<(), String> {
    super::service::ssh_ki_respond(&state, &input.request_id, input.responses)
        .map_err(to_command_error)
}
