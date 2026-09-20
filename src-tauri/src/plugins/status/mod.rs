//! Server-monitor plugin: metric probes and the per-tab status cache.

pub(crate) mod probes;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::models::{FetchServerStatusInput, ServerStatus};
use crate::plugins::lifecycle;
use crate::state::AppState;

/// Extension id from `extensions/builtin.json`.
pub const EXTENSION_ID: &str = "eshell.server-monitor";

/// How long one poll's batched command may take before it is abandoned.
///
/// The generic session-command budget is 30 minutes, which is right for a
/// command the user typed and wrong for a poll: a stalled link would leave the
/// panel frozen for the rest of the session. The batch is five cheap commands
/// plus the process probe's deliberate half-second sample, so this is a
/// generous ceiling that only a genuinely wedged host or link reaches.
const POLL_TIMEOUT: Duration = Duration::from_secs(20);

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
pub async fn fetch_server_status(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: FetchServerStatusInput,
) -> AppResult<ServerStatus> {
    let _active = require_active(state)?;
    let probes = probes::default_probes();
    let script = probes::batch_command(&probes);
    let poll =
        crate::server_ops::run_session_command_for_probe(state, app, &input.session_id, &script);
    let output = match tokio::time::timeout(POLL_TIMEOUT, poll).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            crate::server_ops::append_server_ops_debug_log(
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
            crate::server_ops::append_server_ops_debug_log(
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
pub fn get_cached_server_status(state: &AppState, session_id: &str) -> Option<ServerStatus> {
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

/// Deactivates the plugin: clears its own state, keeps user SSH connections.
///
/// App-exit lifecycle never blocks here: clearing a map is synchronous and
/// bounded; no network or task join happens.
pub fn deactivate(state: &AppState) {
    state.status_plugin().state.deactivate();
}

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
            session_id: super::mcp_tools::arg_str(&args, "sessionId")?,
            selected_interface: None,
        };
        let status = fetch_server_status(&state, None, input)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(status).map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::now_rfc3339;

    fn temp_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-status-plugin-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Arc::new(AppState::new(root).expect("create test state"))
    }

    fn shell_session(id: &str) -> crate::models::ShellSession {
        crate::models::ShellSession {
            id: id.to_string(),
            config_id: "config-1".to_string(),
            config_name: "Test host".to_string(),
            current_dir: "/home/test".to_string(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        }
    }

    fn sample_status() -> ServerStatus {
        ServerStatus {
            cpu_percent: 12.5,
            memory: Default::default(),
            network_interfaces: Vec::new(),
            selected_interface: None,
            selected_interface_traffic: None,
            top_processes: Vec::new(),
            disks: Vec::new(),
            gpus: Vec::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// A status result that raced with `remove_session` must not be cached
    /// for a dead tab: the sessions read lock is held across the insert.
    #[test]
    fn cache_insert_is_ignored_after_the_tab_is_removed() {
        let state = temp_state();
        state.put_session(shell_session("session-1"));
        state
            .status_plugin()
            .state
            .put(&state, "session-1", sample_status());
        assert!(state.status_plugin().state.get("session-1").is_some());

        state.remove_session("session-1").expect("remove shell");
        state
            .status_plugin()
            .state
            .put(&state, "session-1", sample_status());
        assert!(
            state.status_plugin().state.get("session-1").is_none(),
            "a dead tab's cache must not be resurrected"
        );
    }

    /// Tab teardown drops the cache entry (same semantics as before, now
    /// owned by the plugin).
    #[test]
    fn session_removal_drops_the_cached_status() {
        let state = temp_state();
        state.put_session(shell_session("session-1"));
        state
            .status_plugin()
            .state
            .put(&state, "session-1", sample_status());
        state.remove_session("session-1").expect("remove shell");
        assert!(state.status_plugin().state.get("session-1").is_none());
    }

    /// Deactivation clears the plugin's own state and leaves user SSH
    /// sessions (and activation of other extensions) alone.
    #[test]
    fn deactivate_clears_only_the_status_cache() {
        let state = temp_state();
        state.put_session(shell_session("session-1"));
        state
            .status_plugin()
            .state
            .put(&state, "session-1", sample_status());
        assert_eq!(test_cache_len(&state), 1);

        state.status_plugin().state.deactivate();
        assert_eq!(test_cache_len(&state), 0);
        // The tab itself survives: disabling the monitor is not closing SSH.
        assert!(state.get_session("session-1").is_ok());
    }
}
