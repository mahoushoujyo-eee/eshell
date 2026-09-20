//! Server-monitor plugin: metric probes and the per-tab status cache.

pub(crate) mod probes;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::common::error::{AppError, AppResult};
use crate::domain::monitor::consts::*;
pub use crate::domain::monitor::consts::EXTENSION_ID;
use crate::domain::monitor::model::{FetchServerStatusInput, ServerStatus};
use crate::domain::extensions::service::lifecycle;
use crate::state::AppState;

/// Per-tab cached status snapshots.
///
/// Owned here rather than on `AppState`: the status cache is plugin state.
/// `AppState` hands out `&StatusPluginState` and never touches the map.
pub struct StatusPluginState {
    cache: RwLock<HashMap<String, ServerStatus>>,
}

impl StatusPluginState {
    fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// Returns cached status for a session when available.
    pub fn get(&self, session_id: &str) -> Option<ServerStatus> {
        self.cache
            .read()
            .expect("status cache lock poisoned")
            .get(session_id)
            .cloned()
    }

    /// Updates cached status for a session.
    ///
    /// The `sessions` map is held for reading across the insert so a status
    /// result that raced with `remove_session` is not cached for a tab that
    /// no longer exists (the caller's earlier `get_session` check alone can
    /// be overtaken). This preserves the exact previous semantics.
    pub fn put(&self, state: &AppState, session_id: &str, status: ServerStatus) {
        let sessions_guard = state.sessions_read();
        if !sessions_guard.contains_key(session_id) {
            return;
        }
        self.cache
            .write()
            .expect("status cache lock poisoned")
            .insert(session_id.to_string(), status);
    }

    /// Drops the cache entry bound to a closed tab.
    pub fn remove(&self, session_id: &str) {
        self.cache
            .write()
            .expect("status cache lock poisoned")
            .remove(session_id);
    }

    /// Deactivates the plugin for this run: its own bookkeeping is dropped.
    ///
    /// User SSH connections are untouched; disabling the monitor must not
    /// close the tab's transport (the contract: "runtime deactivation cleans
    /// its own state, but does not close the user's SSH connection").
    pub fn deactivate(&self) {
        self.cache
            .write()
            .expect("status cache lock poisoned")
            .clear();
    }
}

/// The server-monitor extension: probes plus the status cache.
pub struct StatusPlugin {
    pub state: StatusPluginState,
}

impl StatusPlugin {
    pub fn new() -> Self {
        Self {
            state: StatusPluginState::new(),
        }
    }
}

impl Default for StatusPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Fails unless the server-monitor extension is active.
///
/// The returned guard holds a busy lease for the awaited work, so a
/// concurrent `set_extension_enabled(_, false)` is rejected instead of
/// deactivating the plugin mid-poll.
pub(crate) fn require_active(state: &AppState) -> AppResult<lifecycle::PluginLease> {
    lifecycle::require_plugin_active(state, EXTENSION_ID)
}

/// Every probe runs in one exec, and no probe holds up PTY, SFTP or another exec.
///
/// The probes used to run as five sequential commands, one channel open and one
/// round trip each. On a slow link that is what put a poll's floor above a
/// one-second refresh interval, and a poll that cannot finish inside its
/// interval is what made the panel look frozen. They are now batched into a
/// single script (see [`probes::batch_command`]) whose output is split back
/// apart by section marker, so the parsers see exactly the bytes they did
/// before.
///
/// A failed exec still aborts the poll with its error, and the completed
/// snapshot is cached only after re-reading the session (no dead-tab
/// resurrection).
pub async fn fetch_server_status_inner(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: FetchServerStatusInput,
) -> AppResult<ServerStatus> {
    let _active = require_active(state)?;
    let probes = probes::default_probes();
    let script = probes::batch_command(&probes);
    let poll =
        crate::domain::ssh::service::session::run_session_command_for_probe(state, app, &input.session_id, &script);
    let output = match tokio::time::timeout(POLL_TIMEOUT, poll).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            crate::common::logging::append_server_ops_debug_log(
                state,
                "status.probe.failed",
                &input.session_id,
                format!("probe=batch error={err}"),
            );
            return Err(err);
        }
        Err(_) => {
            // The command itself is still running on the host; only the wait
            // is abandoned. Dropping the future closes its channel, and the
            // next poll opens a fresh one.
            crate::common::logging::append_server_ops_debug_log(
                state,
                "status.probe.timed_out",
                &input.session_id,
                format!("probe=batch timeout_sec={}", POLL_TIMEOUT.as_secs()),
            );
            return Err(AppError::Runtime(format!(
                "server status poll timed out after {}s",
                POLL_TIMEOUT.as_secs()
            )));
        }
    };

    let mut draft = probes::ServerStatusDraft::default();
    for (probe_id, section) in probes::split_sections(&output) {
        // A section whose probe is gone (an older/newer script) is ignored
        // rather than fatal: the remaining metrics are still worth showing.
        if let Some(probe) = probes.iter().find(|probe| probe.id() == probe_id) {
            probe.apply(&section, &mut draft);
        }
    }
    let status = draft.into_status(input.selected_interface);
    // Do not resurrect a closed tab's cache after its last probe completed.
    state.get_session(&input.session_id)?;
    state
        .status_plugin()
        .state
        .put(state, &input.session_id, status.clone());
    Ok(status)
}

/// Returns cached metrics for instant UI render when switching tabs.
pub fn get_cached_status(state: &AppState, session_id: &str) -> Option<ServerStatus> {
    state.status_plugin().state.get(session_id)
}

/// Tab teardown: drop the closed tab's cache entry.
///
/// Called by `AppState::remove_session`, which owns tab teardown ordering.
pub fn on_session_removed(state: &AppState, session_id: &str) {
    state.status_plugin().state.remove(session_id);
}

/// Whether the server-monitor extension is active this run.
pub fn is_active(state: &AppState) -> bool {
    state.extensions().is_enabled(EXTENSION_ID)
}

// ---------------------------------------------------------------------------
// Tauri command surface
// ---------------------------------------------------------------------------

/// Returns the current server runtime metrics (CPU/memory/network/process/disk).
#[tauri::command]
pub async fn fetch_server_status(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    app: tauri::AppHandle,
    input: FetchServerStatusInput,
) -> Result<ServerStatus, String> {
    let app_state = std::sync::Arc::clone(state.inner());
    fetch_server_status_inner(&app_state, Some(&app), input)
        .await
        .map_err(crate::common::error::to_command_error)
}

/// Returns cached metrics for instant UI render when switching tabs.
#[tauri::command]
pub fn get_cached_server_status(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    session_id: String,
) -> Result<Option<ServerStatus>, String> {
    Ok(get_cached_status(&state, &session_id))
}

/// Deactivates the plugin: clears its own state, keeps user SSH connections.
///
/// App-exit lifecycle never blocks here: clearing a map is synchronous and
/// bounded; no network or task join happens.
pub fn deactivate(state: &AppState) {
    state.status_plugin().state.deactivate();
}

/// Tests use this to reach the raw cache without a live probe run.

/// Tests use this to reach the raw cache without a live probe run.
#[cfg(test)]
pub(crate) fn test_cache_len(state: &AppState) -> usize {
    state
        .status_plugin()
        .state
        .cache
        .read()
        .expect("status cache lock poisoned")
        .len()
}

// ---------------------------------------------------------------------------
// MCP tool handler
// ---------------------------------------------------------------------------

pub(crate) type McpToolFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>;

pub(crate) fn mcp_get_server_status(state: &Arc<AppState>, args: Value) -> McpToolFuture {
    let state = Arc::clone(state);
    Box::pin(async move {
        let input = FetchServerStatusInput {
            session_id: crate::domain::extensions::service::mcp_tools::arg_str(&args, "sessionId")?,
            selected_interface: None,
        };
        let status = fetch_server_status_inner(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(status).map_err(|e| e.to_string())
    })
}
