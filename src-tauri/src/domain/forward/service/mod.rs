//! Port-forward plugin: the runtime registry, the accept loop and the Tauri
//! command surface.
//!
//! # Shape
//!
//! Each forward owns a `tokio::net::TcpListener` and a supervisor task that
//! accepts connections until its `CancellationToken` fires. Every accepted
//! socket opens its own `direct-tcpip` channel on the tab's existing SSH
//! connection, so forwards never contend with the PTY, SFTP or status traffic
//! for a channel — and a stalled tunnel cannot block the accept loop.
//!
//! # Lifetime
//!
//! A forward is bound to a shell tab, not to the app: [`on_session_removed`]
//! stops every forward on a closed tab, mirroring how the server-monitor plugin
//! drops its cache. A dead transport is detected by the supervisor, which marks
//! the row `Failed` instead of leaving a listener that accepts and then hangs.

pub(crate) mod tunnel;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use tauri::State;

use crate::common::error::{to_command_error, AppError, AppResult};
use crate::state::AppState;

use super::model::{
    CreatePortForwardInput, ForwardStatus, ListPortForwardsInput, PortForward, StopPortForwardInput,
    TunnelStats, DEFAULT_BIND_HOST,
};
use tunnel::ForwardRuntime;

/// The forward registry, owned by `AppState` exactly like the SFTP and
/// server-monitor plugin states: the container hands out `&ForwardPlugin` and
/// never touches the maps.
#[derive(Default)]
pub struct ForwardPlugin {
    inner: RwLock<ForwardRegistry>,
}

#[derive(Default)]
struct ForwardRegistry {
    /// Insertion-ordered rows, keyed by forward id.
    forwards: HashMap<String, PortForward>,
    /// Live listeners, keyed by forward id. Absent for `Failed` / `Stopped`
    /// rows, which stay in `forwards` so the UI can show why they died.
    runtimes: HashMap<String, ForwardRuntime>,
}

impl ForwardPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, ForwardRegistry> {
        self.inner.read().expect("forward lock poisoned")
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, ForwardRegistry> {
        self.inner.write().expect("forward lock poisoned")
    }

    /// Every forward, newest last. `session_id` narrows it to one tab.
    pub fn list(&self, session_id: Option<&str>) -> Vec<PortForward> {
        let guard = self.read();
        let mut rows: Vec<PortForward> = guard
            .forwards
            .values()
            .filter(|row| session_id.is_none_or(|id| row.session_id == id))
            .cloned()
            .collect();
        rows.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        rows
    }

    pub fn get(&self, forward_id: &str) -> Option<PortForward> {
        self.read().forwards.get(forward_id).cloned()
    }

    pub(crate) fn insert(&self, row: PortForward) {
        self.write().forwards.insert(row.id.clone(), row);
    }

    pub(crate) fn set_status(&self, forward_id: &str, status: ForwardStatus, error: Option<String>) {
        if let Some(row) = self.write().forwards.get_mut(forward_id) {
            row.status = status;
            row.error = error;
        }
    }

    /// Adds one finished tunnel's counters to the running totals.
    ///
    /// One tunnel ending says nothing about the forward: the listener is still
    /// accepting, so the status and the runtime both stay put.
    pub(crate) fn accumulate_stats(&self, forward_id: &str, stats: TunnelStats) {
        let mut guard = self.write();
        if let Some(row) = guard.forwards.get_mut(forward_id) {
            row.bytes_up = row.bytes_up.saturating_add(stats.bytes_up);
            row.bytes_down = row.bytes_down.saturating_add(stats.bytes_down);
        }
    }

    /// The accept loop exited on its own (transport died, listener failed).
    /// Drops the runtime and records why.
    pub(crate) fn mark_ended(&self, forward_id: &str, error: String) {
        let mut guard = self.write();
        guard.runtimes.remove(forward_id);
        if let Some(row) = guard.forwards.get_mut(forward_id) {
            row.active_connections = 0;
            row.status = ForwardStatus::Failed;
            row.error = Some(error);
        }
    }

    fn attach_runtime(&self, forward_id: &str, runtime: ForwardRuntime) {
        self.write().runtimes.insert(forward_id.to_string(), runtime);
    }

    /// Stops one forward, if it is still running. Returns whether a live
    /// runtime was cancelled.
    pub(crate) fn stop(&self, forward_id: &str) -> bool {
        let runtime = self.write().runtimes.remove(forward_id);
        match runtime {
            Some(runtime) => {
                runtime.cancel();
                true
            }
            None => false,
        }
    }

    /// Stops every forward on a closed tab and forgets the rows.
    pub(crate) fn stop_session(&self, session_id: &str) {
        let ids: Vec<String> = {
            let guard = self.read();
            guard
                .forwards
                .values()
                .filter(|row| row.session_id == session_id)
                .map(|row| row.id.clone())
                .collect()
        };
        for id in ids {
            self.stop(&id);
            self.write().forwards.remove(&id);
        }
    }
}

/// Drops every forward bound to a shell tab. Called from `AppState::remove_session`
/// so a closed tab never leaves a listener behind.
pub fn on_session_removed(state: &AppState, session_id: &str) {
    state.forward_plugin().stop_session(session_id);
}

/// One tunnel ended; its counters roll into the forward's totals. The forward
/// itself keeps running.
pub(crate) fn on_tunnel_finished(state: &AppState, forward_id: &str, stats: TunnelStats) {
    state.forward_plugin().accumulate_stats(forward_id, stats);
}

/// The accept loop exited by itself — the transport died or the listener
/// failed. The row is kept (with the reason) so the user sees why their tunnel
/// stopped instead of watching it disappear.
pub(crate) fn on_forward_ended(state: &AppState, forward_id: &str, error: String) {
    state.forward_plugin().mark_ended(forward_id, error);
}

/// A tunnel opened or closed. Keeps `activeConnections` roughly honest without
/// a full re-list; the exact value is recomputed on every `list`.
pub(crate) fn on_tunnel_count_changed(state: &AppState, forward_id: &str, delta: i32) {
    let plugin = state.forward_plugin();
    let mut guard = plugin.write();
    if let Some(row) = guard.forwards.get_mut(forward_id) {
        row.active_connections = if delta >= 0 {
            row.active_connections.saturating_add(delta as u32)
        } else {
            row.active_connections.saturating_sub(delta.unsigned_abs())
        };
    }
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Returns `(sessionId, bindHost, bindPort, targetHost)`.
fn validate(input: &CreatePortForwardInput) -> AppResult<(String, String, u16, String)> {
    let session_id = input.session_id.trim();
    if session_id.is_empty() {
        return Err(AppError::Validation("sessionId is required".to_string()));
    }
    let target_host = input.target_host.trim();
    if target_host.is_empty() {
        return Err(AppError::Validation("targetHost is required".to_string()));
    }
    if input.target_port == 0 {
        return Err(AppError::Validation("targetPort must be 1-65535".to_string()));
    }
    let bind_host = input
        .bind_host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_BIND_HOST)
        .to_string();
    Ok((
        session_id.to_string(),
        bind_host,
        input.bind_port.unwrap_or(0),
        target_host.to_string(),
    ))
}

/// Creates a forward on `sessionId`'s SSH connection and starts its listener.
///
/// Returns as soon as the listener is bound; the accept loop runs in the
/// background. A bind failure is returned as an error *and* the row is dropped,
/// because there is nothing to show the user in a panel for a port that never
/// opened.
#[tauri::command]
pub async fn create_port_forward(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    input: CreatePortForwardInput,
) -> Result<PortForward, String> {
    let app_state = Arc::clone(state.inner());
    create(&app_state, Some(&app), input)
        .await
        .map_err(to_command_error)
}

/// The domain call behind `create_port_forward`.
///
/// Public to the crate so the extension broker can reach it without a Tauri
/// `State`: the broker holds an `Arc<AppState>`, not a command context.
pub(crate) async fn create(
    state: &Arc<AppState>,
    app: Option<&tauri::AppHandle>,
    input: CreatePortForwardInput,
) -> AppResult<PortForward> {
    let (session_id, bind_host, bind_port, target_host) = validate(&input)?;

    // Resolve the tab's connection up front so a forward on a dead tab fails
    // with the connection error rather than a bind that can never be used.
    // `app` is threaded through because re-establishing a dropped connection
    // can raise a host-key prompt, and that prompt needs a window to render in.
    let connection =
        crate::domain::ssh::service::session::cached_ssh_session(state, app, &session_id).await?;

    let forward_id = uuid::Uuid::new_v4().to_string();
    let row = PortForward {
        id: forward_id.clone(),
        session_id: session_id.clone(),
        bind_host: bind_host.clone(),
        bind_port,
        target_host: target_host.clone(),
        target_port: input.target_port,
        status: ForwardStatus::Starting,
        error: None,
        active_connections: 0,
        bytes_up: 0,
        bytes_down: 0,
        created_at: now_millis(),
    };
    state.forward_plugin().insert(row);

    match tunnel::start(
        Arc::clone(state),
        forward_id.clone(),
        connection,
        bind_host,
        bind_port,
        target_host,
        input.target_port,
    )
    .await
    {
        Ok((runtime, bound_port)) => {
            state.forward_plugin().attach_runtime(&forward_id, runtime);
            let plugin = state.forward_plugin();
            let mut guard = plugin.write();
            let row = guard
                .forwards
                .get_mut(&forward_id)
                .expect("forward row inserted above");
            row.status = ForwardStatus::Active;
            row.bind_port = bound_port;
            Ok(row.clone())
        }
        Err(error) => {
            let plugin = state.forward_plugin();
            plugin.set_status(&forward_id, ForwardStatus::Failed, Some(error.to_string()));
            Err(error)
        }
    }
}

/// The domain call behind `stop_port_forward`. Stopping an already stopped
/// forward is a no-op, not an error.
pub(crate) fn stop(state: &AppState, forward_id: &str) -> AppResult<()> {
    let plugin = state.forward_plugin();
    if plugin.get(forward_id).is_none() {
        return Err(AppError::NotFound(format!("port forward {forward_id}")));
    }
    plugin.stop(forward_id);
    plugin.set_status(forward_id, ForwardStatus::Stopped, None);
    Ok(())
}

/// The domain call behind `forget_port_forward`. Running forwards must be
/// stopped first, so a row can never be forgotten while its listener lives.
pub(crate) fn forget(state: &AppState, forward_id: &str) -> AppResult<()> {
    let plugin = state.forward_plugin();
    let row = plugin
        .get(forward_id)
        .ok_or_else(|| AppError::NotFound(format!("port forward {forward_id}")))?;
    if row.status == ForwardStatus::Active || row.status == ForwardStatus::Starting {
        return Err(AppError::Validation(
            "stop the forward before removing it".to_string(),
        ));
    }
    plugin.write().forwards.remove(forward_id);
    Ok(())
}

/// Stops a forward and closes its listener.
#[tauri::command]
pub fn stop_port_forward(
    state: State<'_, Arc<AppState>>,
    input: StopPortForwardInput,
) -> Result<(), String> {
    stop(&state, &input.forward_id).map_err(to_command_error)
}

/// Lists forwards, optionally narrowed to one shell tab.
#[tauri::command]
pub fn list_port_forwards(
    state: State<'_, Arc<AppState>>,
    input: Option<ListPortForwardsInput>,
) -> Result<Vec<PortForward>, String> {
    let session_id = input.and_then(|args| args.session_id);
    Ok(state.forward_plugin().list(session_id.as_deref()))
}

/// Removes a stopped or failed row from the list.
#[tauri::command]
pub fn forget_port_forward(
    state: State<'_, Arc<AppState>>,
    input: StopPortForwardInput,
) -> Result<(), String> {
    forget(&state, &input.forward_id).map_err(to_command_error)
}
