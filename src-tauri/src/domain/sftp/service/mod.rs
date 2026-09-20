//! SFTP plugin: transfer cancellation state and the operation surface.
//!
//! The operation implementations live in [`ops`]; this module owns the
//! plugin's runtime state (the per-transfer cancellation registry that
//! previously lived on `AppState`) and the active-guard plumbing.

pub(crate) mod ops;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::common::error::AppResult;
use crate::domain::extensions::service::lifecycle;
use crate::state::AppState;

/// Extension id from `extensions/builtin.json`.
///
/// Defined in [`crate::domain::sftp::consts`] and re-exported here so the
/// cross-domain `crate::domain::sftp::service::EXTENSION_ID` path keeps
/// resolving.
pub use crate::domain::sftp::consts::EXTENSION_ID;

/// Per-transfer cancellation markers.
///
/// Owned here rather than on `AppState`: transfer cancellation is plugin
/// state. `AppState` hands out `&SftpPluginState` and never touches the map.
///
/// Semantics preserved exactly from the pre-migration `AppState`:
/// - `begin` reuses an existing token so a `cancel` that arrived first wins
///   (pre-cancel is observed, never lost).
/// - `cancel` before `begin` records a pre-cancelled token.
/// - `clear` removes the marker when the transfer guard drops.
pub struct SftpPluginState {
    transfer_cancellations: RwLock<HashMap<String, CancellationToken>>,
}

impl SftpPluginState {
    fn new() -> Self {
        Self {
            transfer_cancellations: RwLock::new(HashMap::new()),
        }
    }

    /// Marks one transfer as active unless it was already pre-cancelled.
    pub fn begin_transfer(&self, transfer_id: &str) -> CancellationToken {
        let mut guard = self
            .transfer_cancellations
            .write()
            .expect("sftp cancellation lock poisoned");
        guard
            .entry(transfer_id.to_string())
            .or_insert_with(CancellationToken::new)
            .clone()
    }

    /// Requests cancellation for a transfer. Returns whether the transfer was
    /// already registered (pre-cancel bookkeeping preserved).
    pub fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let (existed, token) = {
            let mut guard = self
                .transfer_cancellations
                .write()
                .expect("sftp cancellation lock poisoned");
            let existed = guard.contains_key(transfer_id);
            let token = guard
                .entry(transfer_id.to_string())
                .or_insert_with(CancellationToken::new)
                .clone();
            (existed, token)
        };
        // Cancel outside the write guard: the critical section stays a plain map update.
        token.cancel();
        existed
    }

    /// Checks whether transfer is cancelled.
    #[cfg(test)]
    pub(crate) fn is_transfer_cancelled(&self, transfer_id: &str) -> bool {
        self.transfer_cancellations
            .read()
            .expect("sftp cancellation lock poisoned")
            .get(transfer_id)
            .map(CancellationToken::is_cancelled)
            .unwrap_or(false)
    }

    /// Clears one transfer cancellation marker.
    pub fn clear_transfer(&self, transfer_id: &str) {
        self.transfer_cancellations
            .write()
            .expect("sftp cancellation lock poisoned")
            .remove(transfer_id);
    }

    /// Deactivates the plugin for this run: in-flight transfer markers are
    /// cancelled (they cannot outlive the plugin that owns them) and the map
    /// cleared. User SSH connections are untouched.
    pub fn deactivate(&self) {
        let tokens: Vec<CancellationToken> = {
            let mut guard = self
                .transfer_cancellations
                .write()
                .expect("sftp cancellation lock poisoned");
            let tokens = guard.values().cloned().collect();
            guard.clear();
            tokens
        };
        for token in tokens {
            token.cancel();
        }
    }
}

/// The SFTP extension: the transfer cancellation registry.
///
/// The operations themselves are free functions in [`ops`]; the plugin owns
/// only the state that must survive across them.
pub struct SftpPlugin {
    pub state: SftpPluginState,
}

impl SftpPlugin {
    pub fn new() -> Self {
        Self {
            state: SftpPluginState::new(),
        }
    }
}

impl Default for SftpPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Guards a plugin call: the extension must be active and is leased busy.
pub struct ActiveGuard {
    _lease: lifecycle::PluginLease,
}

/// Fails unless the SFTP extension is active.
///
/// Non-transfer operations take this guard for their whole duration, which is
/// what makes "SFTP 在途操作拒绝停用" hold: the disable is rejected while any
/// listing/read/write/upload/download is running.
pub fn require_active(state: &AppState) -> AppResult<ActiveGuard> {
    lifecycle::require_plugin_active(state, EXTENSION_ID).map(|lease| ActiveGuard { _lease: lease })
}

/// Requests cancellation for a running SFTP transfer.
///
/// Deliberately NOT gated on `require_active`: cancelling a transfer is how a
/// user winds an operation down, so it must work regardless of activation.
/// Cancellation itself is also not a lease: it is synchronous and cannot
/// block a disable.
pub(crate) fn cancel_transfer(state: &AppState, transfer_id: &str) -> bool {
    state.sftp_plugin().state.cancel_transfer(transfer_id)
}

/// Whether the SFTP extension is active this run.
pub fn is_active(state: &AppState) -> bool {
    state.extensions().is_enabled(EXTENSION_ID)
}

/// Deactivates the plugin: cancels outstanding transfer markers and clears
/// its own state. User SSH connections are untouched, and this never blocks
/// app exit.
pub fn deactivate(state: &AppState) {
    state.sftp_plugin().state.deactivate();
}

// ---------------------------------------------------------------------------
// Tauri command surface
//
// Thin adapters so the frontend's `invoke` names stay stable. They decode the
// command input, delegate to `ops`, and flatten errors to strings. The
// with-progress transfers run on a detached task so they keep their own
// lifetime even if the frontend cancels the await; the command still waits
// for the task and reports a task failure as a command error.
// ---------------------------------------------------------------------------

/// Browses one remote directory via SFTP.
#[tauri::command]
pub async fn sftp_list_dir(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpListInput,
) -> Result<crate::domain::sftp::model::SftpListResponse, String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_list_dir(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Reads remote text file content for editor view.
#[tauri::command]
pub async fn sftp_read_file(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpReadInput,
) -> Result<crate::domain::sftp::model::SftpFileContent, String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_read_file(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Writes text editor content back to remote file through SFTP.
#[tauri::command]
pub async fn sftp_write_file(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpWriteInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_write_file(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Creates an empty remote file through SFTP.
#[tauri::command]
pub async fn sftp_create_file(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpCreateInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_create_file(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Creates one remote directory through SFTP.
#[tauri::command]
pub async fn sftp_create_directory(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpCreateInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_create_directory(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Uploads local file bytes (base64 payload) to a remote path via SFTP.
#[tauri::command]
pub async fn sftp_upload_file(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpUploadInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_upload_file(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Deletes one remote file or symlink via SFTP.
#[tauri::command]
pub async fn sftp_delete_entry(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpDeleteInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_delete_entry(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Renames one remote file, symlink, or directory via SFTP.
#[tauri::command]
pub async fn sftp_rename_entry(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpRenameInput,
) -> Result<(), String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_rename_entry(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Uploads local file bytes (base64 payload) and emits transfer progress events.
#[tauri::command]
pub async fn sftp_upload_file_with_progress(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpUploadWithProgressInput,
) -> Result<crate::domain::sftp::model::SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        ops::sftp_upload_file_with_progress(&app_state, &app, input).await
    })
    .await
    .map_err(|error| {
        crate::common::error::to_command_error(crate::common::error::AppError::Runtime(
            error.to_string(),
        ))
    })?
    .map_err(crate::common::error::to_command_error)
}

/// Streams a local file path to a remote path and emits transfer progress events.
#[tauri::command]
pub async fn sftp_upload_local_file_with_progress(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpUploadLocalWithProgressInput,
) -> Result<crate::domain::sftp::model::SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        ops::sftp_upload_local_file_with_progress(&app_state, &app, input).await
    })
    .await
    .map_err(|error| {
        crate::common::error::to_command_error(crate::common::error::AppError::Runtime(
            error.to_string(),
        ))
    })?
    .map_err(crate::common::error::to_command_error)
}

/// Downloads remote file content via SFTP and returns base64 payload.
#[tauri::command]
pub async fn sftp_download_file(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpDownloadInput,
) -> Result<crate::domain::sftp::model::SftpDownloadPayload, String> {
    let app_state = Arc::clone(state.inner());
    ops::sftp_download_file(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Downloads one remote file directly to a local directory with progress events.
#[tauri::command]
pub async fn sftp_download_file_to_local(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: crate::domain::sftp::model::SftpDownloadToLocalInput,
) -> Result<crate::domain::sftp::model::SftpTransferResult, String> {
    let app_state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        ops::sftp_download_file_to_local(&app_state, &app, input).await
    })
    .await
    .map_err(|error| {
        crate::common::error::to_command_error(crate::common::error::AppError::Runtime(
            error.to_string(),
        ))
    })?
    .map_err(crate::common::error::to_command_error)
}

/// Returns default local download directory for current OS.
#[tauri::command]
pub fn sftp_default_download_dir() -> Result<String, String> {
    Ok(ops::default_download_dir())
}

/// Requests cancellation for a running transfer task.
#[tauri::command]
pub fn sftp_cancel_transfer(
    state: tauri::State<'_, Arc<AppState>>,
    input: crate::domain::sftp::model::SftpCancelTransferInput,
) -> Result<bool, String> {
    Ok(state.sftp_plugin().state.cancel_transfer(&input.transfer_id))
}

// ---------------------------------------------------------------------------
// MCP tool handlers
//
// Registered by `plugins::mcp_tools`. The bridge has no AppHandle and only
// ever touches sessions the user already opened, so these pass `None` for
// the app handle: that parameter exists to emit keyboard-interactive 2FA
// prompts while (re)connecting, and a headless HTTP tool call has no UI to
// prompt through — it fails with an error instead, which is the right
// outcome for an agent-triggered call.
// ---------------------------------------------------------------------------

pub(crate) type McpToolFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>;

pub(crate) fn mcp_read_remote_file(state: &Arc<AppState>, args: Value) -> McpToolFuture {
    let state = Arc::clone(state);
    Box::pin(async move {
        let input = crate::domain::sftp::model::SftpReadInput {
            session_id: crate::domain::extensions::service::mcp_tools::arg_str(&args, "sessionId")?,
            path: crate::domain::extensions::service::mcp_tools::arg_str(&args, "path")?,
        };
        let file = ops::sftp_read_file(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(file).map_err(|e| e.to_string())
    })
}

pub(crate) fn mcp_write_remote_file(state: &Arc<AppState>, args: Value) -> McpToolFuture {
    let state = Arc::clone(state);
    Box::pin(async move {
        let input = crate::domain::sftp::model::SftpWriteInput {
            session_id: crate::domain::extensions::service::mcp_tools::arg_str(&args, "sessionId")?,
            path: crate::domain::extensions::service::mcp_tools::arg_str(&args, "path")?,
            content: args
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or("missing argument `content`")?,
        };
        let path = input.path.clone();
        ops::sftp_write_file(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "written": path }))
    })
}

pub(crate) fn mcp_list_remote_dir(state: &Arc<AppState>, args: Value) -> McpToolFuture {
    let state = Arc::clone(state);
    Box::pin(async move {
        let input = crate::domain::sftp::model::SftpListInput {
            session_id: crate::domain::extensions::service::mcp_tools::arg_str(&args, "sessionId")?,
            path: crate::domain::extensions::service::mcp_tools::arg_str(&args, "path")?,
        };
        let listing = ops::sftp_list_dir(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(listing).map_err(|e| e.to_string())
    })
}

/// Re-exported for the SSH session service, which sanitizes remote `pwd`
/// output through the same normalizer (see `sanitize_cwd`).
pub use ops::normalize_remote_path;
