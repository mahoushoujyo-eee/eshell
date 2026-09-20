//! SFTP plugin: transfer cancellation state, the operations and the command surface.
//!
//! This module owns the plugin's runtime state (the per-transfer cancellation
//! registry that previously lived on `AppState`) and the active-guard plumbing,
//! and it holds the Tauri command and MCP adapters.
//!
//! The operations themselves live in the sibling modules below. Every high-level
//! operation opens its own SFTP *session channel* on the single physical
//! `Connection` cached for the shell tab: the connection is never locked or held
//! for the duration of a transfer, so a slow upload can never block a directory
//! listing (or the status poll) on the same tab.
//!
//! Cancellation is token based. A per-transfer `CancellationToken` comes from the
//! plugin state, and the tab-scoped token from `AppState::shell_session_token`
//! fires when the shell session is closed. Network waits race both tokens with
//! `tokio::select!`, so cancellation is observed while a request is in flight
//! rather than only at the next loop iteration. Every terminal path closes its
//! remote file handles before the channel shuts down.
//!
//! # Layout
//!
//! - [`session`] — acquiring the subsystem channel and racing cancellation.
//! - [`files`] — the directory/read/write/create/delete/rename operations.
//! - [`upload`], [`download`] — the two with-progress transfers.
//! - [`remote`] — the low-level remote file-handle helpers those share.
//! - [`progress`] — transfer events, the progress throttle and the transfer guard.
//! - [`paths`] — pure path/OS helpers with no session involved.
//!
//! The operation modules are `pub(crate)` because the extension broker calls the
//! operations directly, bypassing the Tauri command layer.

pub(crate) mod download;
pub(crate) mod files;
pub(crate) mod paths;
pub(crate) mod progress;
pub(crate) mod remote;
pub(crate) mod session;
pub(crate) mod upload;

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
    files::sftp_list_dir(&app_state, Some(&app), input)
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
    files::sftp_read_file(&app_state, Some(&app), input)
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
    files::sftp_write_file(&app_state, Some(&app), input)
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
    files::sftp_create_file(&app_state, Some(&app), input)
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
    files::sftp_create_directory(&app_state, Some(&app), input)
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
    files::sftp_upload_file(&app_state, Some(&app), input)
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
    files::sftp_delete_entry(&app_state, Some(&app), input)
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
    files::sftp_rename_entry(&app_state, Some(&app), input)
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
        upload::sftp_upload_file_with_progress(&app_state, &app, input).await
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
        upload::sftp_upload_local_file_with_progress(&app_state, &app, input).await
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
    files::sftp_download_file(&app_state, Some(&app), input)
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
        download::sftp_download_file_to_local(&app_state, &app, input).await
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
    Ok(paths::default_download_dir())
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
        let file = files::sftp_read_file(&state, None, input)
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
        files::sftp_write_file(&state, None, input)
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
        let listing = files::sftp_list_dir(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(listing).map_err(|e| e.to_string())
    })
}

/// Re-exported for the SSH session service, which sanitizes remote `pwd`
/// output through the same normalizer (see `sanitize_cwd`).
pub use paths::normalize_remote_path;

// Re-exported for `domain/sftp/tests.rs`, which reaches the pure helpers and the
// cancellation messages through `service::*` rather than the submodule they live in.
#[cfg(test)]
pub(crate) use crate::domain::sftp::consts::{
    SFTP_OPERATION_CANCELLED_MESSAGE, SFTP_TRANSFER_CANCELLED_MESSAGE,
};
#[cfg(test)]
pub(crate) use paths::{
    atomic_write_temp_path_with_suffix, entry_type_from_file_type, extract_remote_file_name,
    join_remote_path, normalize_local_dir, renamed_remote_path,
};
#[cfg(test)]
pub(crate) use progress::{compute_transfer_percent, TransferProgressThrottle};
#[cfg(test)]
pub(crate) use remote::{finish_atomic_write_with_fallback, inspect_local_upload_source};
#[cfg(test)]
pub(crate) use session::race_cancel;
