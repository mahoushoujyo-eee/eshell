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

use crate::error::AppResult;
use crate::plugins::lifecycle;
use crate::state::AppState;

/// Extension id from `extensions/builtin.json`.
pub const EXTENSION_ID: &str = "eshell.sftp";

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
pub(crate) fn sftp_cancel_transfer(state: &AppState, transfer_id: &str) -> bool {
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
        let input = crate::models::SftpReadInput {
            session_id: super::mcp_tools::arg_str(&args, "sessionId")?,
            path: super::mcp_tools::arg_str(&args, "path")?,
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
        let input = crate::models::SftpWriteInput {
            session_id: super::mcp_tools::arg_str(&args, "sessionId")?,
            path: super::mcp_tools::arg_str(&args, "path")?,
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
        let input = crate::models::SftpListInput {
            session_id: super::mcp_tools::arg_str(&args, "sessionId")?,
            path: super::mcp_tools::arg_str(&args, "path")?,
        };
        let listing = ops::sftp_list_dir(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(listing).map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-sftp-plugin-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Arc::new(AppState::new(root).expect("create test state"))
    }

    /// The pre-cancel contract moved with the registry: a cancel that arrives
    /// before the transfer begins must be observed, not lost.
    #[test]
    fn transfer_cancellation_preserves_pre_cancel() {
        let state = temp_state();
        let plugin = &state.sftp_plugin().state;

        let active = plugin.begin_transfer("transfer-1");
        assert!(!active.is_cancelled());
        assert!(!plugin.is_transfer_cancelled("transfer-1"));

        assert!(plugin.cancel_transfer("transfer-1"));
        assert!(active.is_cancelled());
        assert!(plugin.is_transfer_cancelled("transfer-1"));

        plugin.clear_transfer("transfer-1");
        assert!(!plugin.is_transfer_cancelled("transfer-1"));

        assert!(!plugin.cancel_transfer("transfer-2"));
        let pre = plugin.begin_transfer("transfer-2");
        assert!(pre.is_cancelled());
        assert!(plugin.is_transfer_cancelled("transfer-2"));
    }

    /// The user-visible cancellation error strings must not drift.
    #[test]
    fn cancellation_error_strings_are_preserved() {
        assert_eq!(
            ops::SFTP_TRANSFER_CANCELLED_MESSAGE,
            "transfer cancelled by user"
        );
        assert_eq!(
            ops::SFTP_OPERATION_CANCELLED_MESSAGE,
            "SFTP operation cancelled by user"
        );
    }

    /// Deactivating cancels outstanding markers and clears the registry,
    /// without touching activation or SSH sessions.
    #[test]
    fn deactivate_cancels_outstanding_markers_and_clears_state() {
        let state = temp_state();
        let plugin = &state.sftp_plugin().state;
        let token = plugin.begin_transfer("transfer-1");
        assert!(!token.is_cancelled());

        plugin.deactivate();
        assert!(token.is_cancelled(), "outstanding marker must be cancelled");
        assert!(!plugin.is_transfer_cancelled("transfer-1"));
    }

    /// The busy lease must cover the real worker, not just the call that
    /// started it: while an operation is in flight (guard held), disabling
    /// the extension is rejected; once the worker finishes or cleans up, the
    /// disable goes through.
    #[tokio::test]
    async fn lease_covers_the_worker_until_it_finishes() {
        let state = temp_state();

        // An operation starts: the guard is taken before any work, exactly as
        // every op in `ops.rs` does.
        let guard = require_active(&state).expect("active extension");

        // While the worker runs, a disable must be rejected.
        assert!(matches!(
            state.extensions().set_enabled(EXTENSION_ID, false),
            Err(crate::error::AppError::Validation(_))
        ));
        assert!(is_active(&state));

        // The worker ends (success, failure or cancel cleanup): the guard
        // drops with it, and the disable now succeeds.
        drop(guard);
        state
            .extensions()
            .set_enabled(EXTENSION_ID, false)
            .expect("disable after the worker finished");
        assert!(!is_active(&state));
    }

    /// A pre-cancel placeholder must not leave the extension permanently
    /// busy: the transfer guard clears it on drop, and the busy counter is
    /// only ever held by a live operation guard.
    #[tokio::test]
    async fn pre_cancel_placeholder_does_not_leave_the_extension_busy() {
        let state = temp_state();

        // A cancel arrives before the transfer begins: the plugin records a
        // pre-cancelled marker, exactly as before the migration.
        assert!(!state.sftp_plugin().state.cancel_transfer("transfer-x"));

        // No operation is running, so a disable must not be blocked by the
        // orphan placeholder.
        state
            .extensions()
            .set_enabled(EXTENSION_ID, false)
            .expect("disable with only a pre-cancel placeholder");

        // And the placeholder itself is cancellable/queryable as before.
        let token = state.sftp_plugin().state.begin_transfer("transfer-x");
        assert!(token.is_cancelled(), "the pre-cancel must be observed");
        state.sftp_plugin().state.clear_transfer("transfer-x");
        assert!(
            !state
                .sftp_plugin()
                .state
                .is_transfer_cancelled("transfer-x"),
            "guard drop must clear the placeholder"
        );
    }

    /// The ops themselves fail closed on a deactivated extension: no wire
    /// traffic, no plugin state writes.
    #[tokio::test]
    async fn operations_fail_closed_when_the_extension_is_disabled() {
        let state = temp_state();
        state
            .extensions()
            .set_enabled(EXTENSION_ID, false)
            .expect("disable");

        let error = ops::sftp_list_dir(
            &state,
            None,
            crate::models::SftpListInput {
                session_id: "session-1".to_string(),
                path: "/".to_string(),
            },
        )
        .await
        .expect_err("a disabled extension must refuse the call");
        assert!(
            error.to_string().contains("disabled"),
            "the error must name the disabled extension: {error}"
        );
    }
}
