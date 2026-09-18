use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::models::{ServerStatus, ShellSession};
use crate::ops_agent::acp::commands::AcpAgentRegistry;
use crate::ops_agent::infrastructure::agent_trace_store::OpsAgentTraceStore;
use crate::ops_agent::infrastructure::attachments::OpsAgentAttachmentStore;
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunRegistry;
use crate::ops_agent::infrastructure::store::OpsAgentStore;
use crate::ops_agent::tools::{default_ops_agent_tool_registry, OpsAgentToolRegistry};
use crate::server_ops::transport::Connection;
use crate::storage::Storage;

/// One long-lived SSH connection, shared by every operation on a shell tab.
///
/// The transport owns the actual socket and a background reader; `Arc` lets the
/// cache and any in-flight operation hold the same handle, while
/// [`Connection::shutdown`] is the explicit close signal (dropping the last
/// `Arc` must not be relied on, because the reader task keeps the socket alive).
pub type SharedSshSession = Arc<Connection>;

#[derive(Debug, Clone)]
pub enum PtyCommand {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// Where the local MCP bridge is listening, plus the per-run bearer token
/// agents must present. Set once at startup by `mcp_bridge::start`.
#[derive(Debug, Clone)]
pub struct McpBridgeInfo {
    pub port: u16,
    pub token: String,
}

/// Shared application state managed by Tauri.
///
/// Design goals:
/// - Keep persistent data concerns in `Storage`.
/// - Keep runtime-only data (shell sessions, status cache) in memory.
/// - Keep core logic testable by not tightly coupling service code to Tauri types.
///
/// Locking:
/// - Every map other than the per-tab connect lock is a plain `std` `RwLock`.
///   Those critical sections are short and synchronous; no guard is ever held
///   across an `.await`.
/// - Establishing a connection is serialized per shell tab with a
///   `tokio::sync::Mutex`, because the handshake is asynchronous (seconds long)
///   and must not block the other tabs' maps.
pub struct AppState {
    pub storage: Storage,
    pub ops_agent: OpsAgentStore,
    pub ops_agent_attachments: OpsAgentAttachmentStore,
    pub ops_agent_traces: OpsAgentTraceStore,
    pub ops_agent_tools: OpsAgentToolRegistry,
    pub ops_agent_runs: OpsAgentRunRegistry,
    pub acp_agents: AcpAgentRegistry,
    mcp_bridge: RwLock<Option<McpBridgeInfo>>,
    sessions: RwLock<HashMap<String, ShellSession>>,
    /// One connection per shell tab, keyed by session id only.
    ssh_sessions: RwLock<HashMap<String, SharedSshSession>>,
    /// One lock per shell tab, held across that tab's handshake. Connecting must
    /// not hold `ssh_sessions` itself: a handshake takes seconds and that map is
    /// shared by every tab.
    ssh_connect_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    status_cache: RwLock<HashMap<String, ServerStatus>>,
    /// PTY control channel per shell tab, tagged with the generation of the
    /// worker that registered it. A tab can outlive several PTY workers (see
    /// [`AppState::reopen_pty_channel`]), and a worker that is being replaced
    /// must not unregister its successor's channel on the way out.
    pty_channels: RwLock<HashMap<String, (u64, UnboundedSender<PtyCommand>)>>,
    /// Source of [`AppState::pty_channels`] generations. Monotonic, never reset.
    pty_generations: AtomicU64,
    /// Cancellation token per shell tab. Created by `put_session`, never reset by
    /// later updates, and cancelled by `remove_session`.
    shell_session_tokens: RwLock<HashMap<String, CancellationToken>>,
    shell_connection_cancellations: RwLock<HashMap<String, CancellationToken>>,
    sftp_transfer_cancellations: RwLock<HashMap<String, CancellationToken>>,
    ki_pending: RwLock<HashMap<String, oneshot::Sender<Vec<String>>>>,
}

impl AppState {
    /// Creates a fully initialized state object backed by a storage root path.
    pub fn new(storage_root: PathBuf) -> AppResult<Self> {
        Self::new_with_ops_agent_tools(storage_root, default_ops_agent_tool_registry())
    }

    /// Creates a fully initialized state object with a caller-provided Ops Agent tool registry.
    pub fn new_with_ops_agent_tools(
        storage_root: PathBuf,
        ops_agent_tools: OpsAgentToolRegistry,
    ) -> AppResult<Self> {
        Ok(Self {
            storage: Storage::new(storage_root.clone())?,
            ops_agent: OpsAgentStore::new(storage_root.clone())?,
            ops_agent_attachments: OpsAgentAttachmentStore::new(storage_root.clone())?,
            ops_agent_traces: OpsAgentTraceStore::new(storage_root)?,
            ops_agent_tools,
            ops_agent_runs: OpsAgentRunRegistry::new(),
            acp_agents: AcpAgentRegistry::new(),
            mcp_bridge: RwLock::new(None),
            sessions: RwLock::new(HashMap::new()),
            ssh_sessions: RwLock::new(HashMap::new()),
            ssh_connect_locks: Mutex::new(HashMap::new()),
            status_cache: RwLock::new(HashMap::new()),
            pty_channels: RwLock::new(HashMap::new()),
            pty_generations: AtomicU64::new(0),
            shell_session_tokens: RwLock::new(HashMap::new()),
            shell_connection_cancellations: RwLock::new(HashMap::new()),
            sftp_transfer_cancellations: RwLock::new(HashMap::new()),
            ki_pending: RwLock::new(HashMap::new()),
        })
    }

    /// Returns all active shell sessions in a stable creation order.
    ///
    /// The backing map has no ordering, and the frontend renders this list as the
    /// tab bar. Returning raw map order let tabs reshuffle on every reload, so the
    /// order is pinned to creation time with the id as a tiebreaker.
    pub fn list_sessions(&self) -> Vec<ShellSession> {
        let mut sessions: Vec<ShellSession> = self
            .sessions
            .read()
            .expect("session lock poisoned")
            .values()
            .cloned()
            .collect();
        sessions.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        sessions
    }

    /// Stores or updates a shell session in the runtime registry.
    /// Records where the local MCP bridge listens.
    pub fn set_mcp_bridge(&self, info: McpBridgeInfo) {
        *self.mcp_bridge.write().expect("mcp bridge lock poisoned") = Some(info);
    }

    /// Returns the local MCP bridge endpoint, if it started successfully.
    pub fn mcp_bridge(&self) -> Option<McpBridgeInfo> {
        self.mcp_bridge
            .read()
            .expect("mcp bridge lock poisoned")
            .clone()
    }

    /// Stores or updates a shell session and ensures it has a live cancellation token.
    ///
    /// Updating an existing session must not replace its token: PTY / SFTP work
    /// already holds it, and a reset would silently detach that work from a later
    /// `remove_session`.
    pub fn put_session(&self, session: ShellSession) {
        let session_id = session.id.clone();
        // Hold `sessions` across the token creation so no reader can observe the
        // session without its token (which `get_or_insert_ssh_session` validates).
        let mut sessions = self.sessions.write().expect("session lock poisoned");
        sessions.insert(session_id.clone(), session);
        self.shell_session_tokens
            .write()
            .expect("shell session token lock poisoned")
            .entry(session_id)
            .or_insert_with(CancellationToken::new);
    }

    /// Retrieves a shell session by id.
    pub fn get_session(&self, session_id: &str) -> AppResult<ShellSession> {
        self.sessions
            .read()
            .expect("session lock poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("shell session {session_id}")))
    }

    /// Applies an update closure to a session atomically.
    pub fn mutate_session<F>(&self, session_id: &str, mutator: F) -> AppResult<ShellSession>
    where
        F: FnOnce(&mut ShellSession),
    {
        let mut guard = self.sessions.write().expect("session lock poisoned");
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound(format!("shell session {session_id}")))?;
        mutator(session);
        Ok(session.clone())
    }

    /// Returns the cancellation token bound to one shell tab.
    ///
    /// The token is cancelled by [`AppState::remove_session`], so a PTY worker or
    /// long-running transfer can observe tab closure without polling the session map.
    pub fn shell_session_token(&self, session_id: &str) -> AppResult<CancellationToken> {
        self.shell_session_tokens
            .read()
            .expect("shell session token lock poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("shell session {session_id}")))
    }

    /// Removes a shell session and any stale cache bound to that session.
    pub fn remove_session(&self, session_id: &str) -> AppResult<()> {
        let removed = self
            .sessions
            .write()
            .expect("session lock poisoned")
            .remove(session_id);
        if removed.is_none() {
            return Err(AppError::NotFound(format!("shell session {session_id}")));
        }
        self.remove_pty_channel(session_id);

        if let Some(token) = self
            .shell_session_tokens
            .write()
            .expect("shell session token lock poisoned")
            .remove(session_id)
        {
            token.cancel();
        }

        self.status_cache
            .write()
            .expect("status cache lock poisoned")
            .remove(session_id);
        self.remove_ssh_session(session_id);
        Ok(())
    }

    /// Returns the cached connection for a shell tab, creating it once when absent.
    ///
    /// `connect` runs without holding any state map, because establishing an SSH
    /// connection takes seconds (TCP + handshake + auth) and the maps are shared by
    /// every open tab. Concurrent callers for the *same* tab still take turns on a
    /// per-tab `tokio::sync::Mutex` and re-check the cache afterwards, so a burst of
    /// operations on a fresh tab opens one connection rather than one per caller.
    /// Callers for different tabs never block each other.
    ///
    /// Close-vs-insert race: the `sessions` map is held for reading across the
    /// existence check *and* the cache insertion. `remove_session` takes that same
    /// map for writing before it touches `ssh_sessions`, so a tab can never be seen
    /// as live here and then closed-and-forgotten before the connection is cached.
    /// If the tab closed during the handshake the fresh connection is shut down
    /// instead of inserted, so nothing leaks and removal stays authoritative.
    ///
    /// Tab teardown also wins over queued work: the tab token is validated before
    /// the per-tab lock is touched, and it is raced against both the lock wait and
    /// the handshake itself. A caller waiting behind another handshake therefore
    /// aborts when the tab closes instead of starting a fresh handshake afterwards.
    pub async fn get_or_insert_ssh_session<F, Fut>(
        &self,
        session_id: &str,
        connect: F,
    ) -> AppResult<SharedSshSession>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = AppResult<Connection>> + Send,
    {
        // Validate the tab before taking any lock. After `remove_session` the token
        // is gone, so stale callers fail fast rather than opening a new connection.
        let tab_cancel = self.shell_session_token(session_id)?;
        if tab_cancel.is_cancelled() {
            return Err(AppError::NotFound(format!("shell session {session_id}")));
        }

        if let Some(connection) = self.cached_ssh_session(session_id) {
            return Ok(connection);
        }

        let connect_lock = self.ssh_connect_lock(session_id);
        // A caller queued behind another handshake must give up when the tab closes,
        // otherwise it would start a fresh handshake after removal.
        let _connect_guard = tokio::select! {
            biased;
            _ = tab_cancel.cancelled() => {
                return Err(AppError::NotFound(format!("shell session {session_id}")));
            }
            guard = connect_lock.lock() => guard,
        };

        // Another caller may have finished connecting for this tab while we waited.
        if let Some(connection) = self.cached_ssh_session(session_id) {
            return Ok(connection);
        }
        if tab_cancel.is_cancelled() {
            return Err(AppError::NotFound(format!("shell session {session_id}")));
        }

        // The handshake races the tab token too: a close during connect drops the
        // connect future instead of letting it cache a connection for a dead tab.
        let connection = tokio::select! {
            biased;
            _ = tab_cancel.cancelled() => {
                return Err(AppError::NotFound(format!("shell session {session_id}")));
            }
            result = connect() => result?,
        };
        let shared = Arc::new(connection);

        {
            let sessions_guard = self.sessions.read().expect("session lock poisoned");
            if !sessions_guard.contains_key(session_id) {
                // The tab was closed during the handshake. Release the read lock
                // before closing so the shutdown never runs under a state lock.
                drop(sessions_guard);
                shared.shutdown();
                return Err(AppError::NotFound(format!("shell session {session_id}")));
            }

            self.ssh_sessions
                .write()
                .expect("ssh session lock poisoned")
                .insert(session_id.to_string(), Arc::clone(&shared));
        }

        Ok(shared)
    }

    /// Caches an already-connected transport for one shell tab.
    ///
    /// Used to seed the connection opened by the PTY worker so later operations
    /// reuse it instead of dialing again. The caller must have registered the
    /// session first (`put_session`). A missing tab returns `NotFound` and never
    /// resurrects the cache entry, matching `get_or_insert_ssh_session`: the
    /// `sessions` read guard is held across the cache insertion so a concurrent
    /// `remove_session` cannot interleave between the check and the insert.
    ///
    /// Replacing an existing connection shuts the previous one down.
    pub fn put_ssh_session(&self, session_id: &str, connection: SharedSshSession) -> AppResult<()> {
        let sessions_guard = self.sessions.read().expect("session lock poisoned");
        if !sessions_guard.contains_key(session_id) {
            return Err(AppError::NotFound(format!("shell session {session_id}")));
        }

        let previous = self
            .ssh_sessions
            .write()
            .expect("ssh session lock poisoned")
            .insert(session_id.to_string(), Arc::clone(&connection));
        drop(sessions_guard);

        if let Some(previous) = previous {
            if !Arc::ptr_eq(&previous, &connection) {
                previous.shutdown();
            }
        }
        Ok(())
    }

    fn cached_ssh_session(&self, session_id: &str) -> Option<SharedSshSession> {
        self.ssh_sessions
            .read()
            .expect("ssh session lock poisoned")
            .get(session_id)
            .cloned()
    }

    fn ssh_connect_lock(&self, session_id: &str) -> Arc<AsyncMutex<()>> {
        let mut guard = self
            .ssh_connect_locks
            .lock()
            .expect("ssh connect lock registry poisoned");
        Arc::clone(guard.entry(session_id.to_string()).or_default())
    }

    /// Drops the cached connection after its transport turned out to be dead.
    ///
    /// Only evicts when the cache still holds the very same `Arc`, so a caller
    /// that observed a stale connection never throws away a fresh one that another
    /// caller has already re-established in the meantime. `Arc::ptr_eq` is the
    /// exact generation check: pointer equality only holds for the same
    /// allocation. The evicted connection is shut down so its reader task ends.
    /// Returns whether an entry was removed.
    pub fn evict_ssh_session(&self, session_id: &str, stale: &SharedSshSession) -> bool {
        let removed = {
            let mut guard = self
                .ssh_sessions
                .write()
                .expect("ssh session lock poisoned");
            let is_observed_connection = guard
                .get(session_id)
                .is_some_and(|current| Arc::ptr_eq(current, stale));
            if is_observed_connection {
                guard.remove(session_id)
            } else {
                None
            }
        };

        match removed {
            Some(_) => {
                stale.shutdown();
                true
            }
            None => false,
        }
    }

    /// Removes the cached connection for one shell session and closes it.
    pub fn remove_ssh_session(&self, session_id: &str) {
        let removed = self
            .ssh_sessions
            .write()
            .expect("ssh session lock poisoned")
            .remove(session_id);
        if let Some(connection) = removed {
            connection.shutdown();
        }

        self.ssh_connect_locks
            .lock()
            .expect("ssh connect lock registry poisoned")
            .remove(session_id);
    }

    #[cfg(test)]
    pub fn has_ssh_session(&self, session_id: &str) -> bool {
        self.ssh_sessions
            .read()
            .expect("ssh session lock poisoned")
            .contains_key(session_id)
    }

    /// Registers or replaces PTY control channel for one shell session.
    ///
    /// Returns the generation the caller's worker was registered under, which it
    /// must pass back to [`AppState::remove_pty_channel_if_current`] when it
    /// exits. A tab can outlive its PTY worker — `reopen_shell_pty` replaces a
    /// dead channel without touching the session — so an outgoing worker that
    /// unregistered unconditionally would tear down its own replacement.
    ///
    /// The sender is a tokio unbounded sender, whose `send` is synchronous, so the
    /// Tauri command layer can forward frontend keystrokes without an executor
    /// turn (and without blocking on a full channel).
    ///
    /// The `sessions` map is held for reading across the registration so a PTY
    /// worker seeded concurrently with `remove_session` cannot leave a channel
    /// behind for a tab that is gone. When the tab is already closed the sender is
    /// dropped (after a close hint) so the worker's receiver ends and it exits.
    pub fn put_pty_channel(&self, session_id: String, sender: UnboundedSender<PtyCommand>) -> u64 {
        let generation = self.pty_generations.fetch_add(1, Ordering::Relaxed);
        let sessions_guard = self.sessions.read().expect("session lock poisoned");
        if !sessions_guard.contains_key(session_id.as_str()) {
            drop(sessions_guard);
            let _ = sender.send(PtyCommand::Close);
            return generation;
        }

        if let Some((_, previous)) = self
            .pty_channels
            .write()
            .expect("pty channel lock poisoned")
            .insert(session_id, (generation, sender))
        {
            let _ = previous.send(PtyCommand::Close);
        }
        generation
    }

    /// Sends PTY control message to one shell session worker.
    pub fn send_pty_command(&self, session_id: &str, command: PtyCommand) -> AppResult<()> {
        let sender = self
            .pty_channels
            .read()
            .expect("pty channel lock poisoned")
            .get(session_id)
            .map(|(_, sender)| sender.clone())
            .ok_or_else(|| AppError::NotFound(format!("pty session {session_id}")))?;
        sender
            .send(command)
            .map_err(|_| AppError::Runtime(format!("pty worker channel closed for {session_id}")))
    }

    /// Unregisters PTY channel and asks worker to stop.
    pub fn remove_pty_channel(&self, session_id: &str) {
        if let Some((_, sender)) = self
            .pty_channels
            .write()
            .expect("pty channel lock poisoned")
            .remove(session_id)
        {
            let _ = sender.send(PtyCommand::Close);
        }
    }

    /// Whether `generation` is still the live PTY worker for this tab.
    ///
    /// A worker that has been superseded — the tab was reopened while it was
    /// still winding down — must not tear down the tab on its way out.
    pub fn is_current_pty_generation(&self, session_id: &str, generation: u64) -> bool {
        self.pty_channels
            .read()
            .expect("pty channel lock poisoned")
            .get(session_id)
            .is_some_and(|(current, _)| *current == generation)
    }

    /// Unregisters the PTY channel only if it still belongs to `generation`.
    ///
    /// A worker calls this on exit. If the channel has already been replaced —
    /// the tab was reopened while this worker was still winding down — the
    /// replacement is left alone, because it is the live one.
    pub fn remove_pty_channel_if_current(&self, session_id: &str, generation: u64) {
        let mut guard = self.pty_channels.write().expect("pty channel lock poisoned");
        let is_current = guard
            .get(session_id)
            .is_some_and(|(current, _)| *current == generation);
        if !is_current {
            return;
        }
        if let Some((_, sender)) = guard.remove(session_id) {
            let _ = sender.send(PtyCommand::Close);
        }
    }

    /// Marks one shell connection attempt as active unless it was already pre-cancelled.
    ///
    /// Returns the token the attempt must observe. An existing token is reused
    /// unchanged, so a `cancel_shell_connection` that arrived first still wins.
    pub fn begin_shell_connection(&self, request_id: &str) -> CancellationToken {
        let mut guard = self
            .shell_connection_cancellations
            .write()
            .expect("shell connection cancellation lock poisoned");
        guard
            .entry(request_id.to_string())
            .or_insert_with(CancellationToken::new)
            .clone()
    }

    /// Requests cancellation for a shell connection attempt.
    ///
    /// Returns whether the attempt was already registered. Cancelling before the
    /// attempt begins records a pre-cancelled token, so the later
    /// `begin_shell_connection` observes cancellation instead of starting work.
    pub fn cancel_shell_connection(&self, request_id: &str) -> bool {
        let (existed, token) = {
            let mut guard = self
                .shell_connection_cancellations
                .write()
                .expect("shell connection cancellation lock poisoned");
            let existed = guard.contains_key(request_id);
            let token = guard
                .entry(request_id.to_string())
                .or_insert_with(CancellationToken::new)
                .clone();
            (existed, token)
        };
        // Cancel outside the write guard: the critical section stays a plain map update.
        token.cancel();
        existed
    }

    /// Checks whether a shell connection attempt is cancelled.
    pub fn is_shell_connection_cancelled(&self, request_id: &str) -> bool {
        self.shell_connection_cancellations
            .read()
            .expect("shell connection cancellation lock poisoned")
            .get(request_id)
            .map(CancellationToken::is_cancelled)
            .unwrap_or(false)
    }

    /// Clears one shell connection cancellation marker.
    pub fn clear_shell_connection(&self, request_id: &str) {
        self.shell_connection_cancellations
            .write()
            .expect("shell connection cancellation lock poisoned")
            .remove(request_id);
    }

    /// Returns cached status for a session when available.
    pub fn get_cached_status(&self, session_id: &str) -> Option<ServerStatus> {
        self.status_cache
            .read()
            .expect("status cache lock poisoned")
            .get(session_id)
            .cloned()
    }

    /// Updates cached status for a session.
    ///
    /// The `sessions` map is held for reading across the insert so a status result
    /// that raced with `remove_session` is not cached for a tab that no longer
    /// exists (the caller's earlier `get_session` check alone can be overtaken).
    pub fn put_cached_status(&self, session_id: &str, status: ServerStatus) {
        let sessions_guard = self.sessions.read().expect("session lock poisoned");
        if !sessions_guard.contains_key(session_id) {
            return;
        }
        self.status_cache
            .write()
            .expect("status cache lock poisoned")
            .insert(session_id.to_string(), status);
    }

    /// Marks one transfer as active unless it was already pre-cancelled.
    ///
    /// Returns the token the transfer must observe. An existing token is reused
    /// unchanged, so a `cancel_sftp_transfer` that arrived first still wins.
    pub fn begin_sftp_transfer(&self, transfer_id: &str) -> CancellationToken {
        let mut guard = self
            .sftp_transfer_cancellations
            .write()
            .expect("sftp cancellation lock poisoned");
        guard
            .entry(transfer_id.to_string())
            .or_insert_with(CancellationToken::new)
            .clone()
    }

    /// Requests cancellation for a transfer.
    ///
    /// Returns whether the transfer was already registered. Cancelling before the
    /// transfer begins records a pre-cancelled token, so the later
    /// `begin_sftp_transfer` observes cancellation instead of starting work.
    pub fn cancel_sftp_transfer(&self, transfer_id: &str) -> bool {
        let (existed, token) = {
            let mut guard = self
                .sftp_transfer_cancellations
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
    pub fn is_sftp_transfer_cancelled(&self, transfer_id: &str) -> bool {
        self.sftp_transfer_cancellations
            .read()
            .expect("sftp cancellation lock poisoned")
            .get(transfer_id)
            .map(CancellationToken::is_cancelled)
            .unwrap_or(false)
    }

    /// Clears one transfer cancellation marker.
    pub fn clear_sftp_transfer(&self, transfer_id: &str) {
        self.sftp_transfer_cancellations
            .write()
            .expect("sftp cancellation lock poisoned")
            .remove(transfer_id);
    }

    /// Registers a sender to receive keyboard-interactive responses for one auth challenge.
    pub fn put_ki_pending(&self, request_id: &str, sender: oneshot::Sender<Vec<String>>) {
        self.ki_pending
            .write()
            .expect("ki pending lock poisoned")
            .insert(request_id.to_string(), sender);
    }

    /// Delivers keyboard-interactive responses to the waiting auth thread.
    pub fn respond_ki(&self, request_id: &str, responses: Vec<String>) -> AppResult<()> {
        let sender = self
            .ki_pending
            .write()
            .expect("ki pending lock poisoned")
            .remove(request_id)
            .ok_or_else(|| AppError::NotFound(format!("ki challenge {request_id}")))?;
        sender.send(responses).map_err(|_| {
            AppError::Runtime(format!("ki challenge {request_id} receiver already gone"))
        })
    }

    /// Removes stale KI pending entry (cleanup on timeout or cancel).
    pub fn clear_ki_pending(&self, request_id: &str) {
        self.ki_pending
            .write()
            .expect("ki pending lock poisoned")
            .remove(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{now_rfc3339, SshAuthType, SshConfig, TrustSshHostKeyInput};
    use crate::server_ops::transport;
    use crate::server_ops::transport::test_support::{
        TestSshServer, TEST_SSH_PASSWORD, TEST_SSH_USERNAME,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    /// An in-process SSH server plus the host-key trust and config needed to reach it.
    ///
    /// Every fixture owns its own server, so tests open real localhost russh
    /// connections instead of a libssh2 dummy. Keep it alive for the whole test:
    /// dropping it only leaks the (task-held) listener, but the connections the
    /// tests opened are shut down explicitly through the state under test.
    struct TestFixture {
        _server: TestSshServer,
        config: SshConfig,
    }

    impl TestFixture {
        async fn start(state: &AppState) -> Self {
            let server = TestSshServer::start().await.expect("start test ssh server");
            state
                .storage
                .trust_ssh_host_key(TrustSshHostKeyInput {
                    host: "127.0.0.1".to_string(),
                    port: server.addr().port(),
                    key_type: server.key_type().to_string(),
                    fingerprint: server.fingerprint().to_string(),
                })
                .expect("trust test host key");

            let config = SshConfig {
                id: "config-1".to_string(),
                name: "Test host".to_string(),
                host: "127.0.0.1".to_string(),
                port: server.addr().port(),
                username: TEST_SSH_USERNAME.to_string(),
                auth_type: SshAuthType::Password,
                password: TEST_SSH_PASSWORD.to_string(),
                private_key_path: String::new(),
                private_key_passphrase: String::new(),
                use_password_fallback: false,
                jump_host_id: None,
                description: String::new(),
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
            };

            Self {
                _server: server,
                config,
            }
        }
    }

    /// Opens one real connection to the fixture's localhost server.
    async fn open_connection(state: &Arc<AppState>, config: &SshConfig) -> AppResult<Connection> {
        transport::connect(state, None, config, CancellationToken::new()).await
    }

    /// Builds a `get_or_insert_ssh_session` connector for a fixture.
    ///
    /// The fresh clones keep the connector independent of the receiver borrow,
    /// which `get_or_insert_ssh_session` holds while it calls the closure.
    macro_rules! connector {
        ($state:expr, $config:expr) => {{
            let state = Arc::clone(&$state);
            let config = $config.clone();
            move || async move {
                transport::connect(&state, None, &config, CancellationToken::new()).await
            }
        }};
    }

    fn temp_state(name: &str) -> AppState {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("eshell-state-{name}-{nonce}"));
        AppState::new(root).expect("create app state")
    }

    fn shell_session(id: &str) -> ShellSession {
        shell_session_created_at(id, &now_rfc3339())
    }

    fn shell_session_created_at(id: &str, created_at: &str) -> ShellSession {
        ShellSession {
            id: id.to_string(),
            config_id: "config-1".to_string(),
            config_name: "Test host".to_string(),
            current_dir: "/home/test".to_string(),
            last_output: String::new(),
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
        }
    }

    /// The tab bar renders `list_sessions` directly, so an unordered result made
    /// tabs jump around whenever the frontend reloaded the session list.
    #[test]
    fn list_sessions_is_ordered_by_creation_and_stable_across_calls() {
        let state = temp_state("session-order");
        state.put_session(shell_session_created_at(
            "session-c",
            "2026-09-14T06:44:28.000000000+00:00",
        ));
        state.put_session(shell_session_created_at(
            "session-a",
            "2026-09-14T06:01:08.000000000+00:00",
        ));
        state.put_session(shell_session_created_at(
            "session-b",
            "2026-09-14T06:01:30.000000000+00:00",
        ));

        let ids: Vec<String> = state.list_sessions().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["session-a", "session-b", "session-c"]);

        // Repeated reads must not reshuffle, and neither must an unrelated insert.
        assert_eq!(
            state
                .list_sessions()
                .into_iter()
                .map(|s| s.id)
                .collect::<Vec<_>>(),
            ids
        );
        state.put_session(shell_session_created_at(
            "session-d",
            "2026-09-14T07:00:00.000000000+00:00",
        ));
        assert_eq!(
            state
                .list_sessions()
                .into_iter()
                .map(|s| s.id)
                .take(3)
                .collect::<Vec<_>>(),
            ids
        );
    }

    /// An SSH handshake takes seconds. It must not be performed while holding the
    /// shared session map, or every other tab freezes until it finishes.
    #[tokio::test]
    async fn connecting_one_tab_does_not_block_another_tab() {
        let state = Arc::new(temp_state("ssh-parallel-connect"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));
        state.put_session(shell_session("session-2"));

        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();

        let gate_state = Arc::clone(&state);
        let gate_config = config.clone();
        let slow = {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                state
                    .get_or_insert_ssh_session("session-1", move || async move {
                        let _ = started_tx.send(());
                        let _ = release_rx.await;
                        open_connection(&gate_state, &gate_config).await
                    })
                    .await
            })
        };

        started_rx.await.expect("slow connect started");

        // Run the second tab's connect under a timeout so a regression shows up as
        // a clean failure instead of hanging the test binary.
        let fast = tokio::time::timeout(
            Duration::from_secs(10),
            state.get_or_insert_ssh_session("session-2", connector!(state, config)),
        )
        .await
        .expect("a tab must be able to connect while another tab is still handshaking");
        assert!(fast.is_ok());

        let _ = release_tx.send(());
        slow.await
            .expect("join slow connect")
            .expect("slow connect");
    }

    /// A fresh tab fires several operations at once (SFTP listing, status poll).
    /// They must share one handshake instead of racing into several connections.
    #[tokio::test]
    async fn concurrent_callers_for_one_tab_open_a_single_connection() {
        let state = Arc::new(temp_state("ssh-single-connect"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));
        let connects = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let state = Arc::clone(&state);
                let config = config.clone();
                let connects = Arc::clone(&connects);
                tokio::spawn(async move {
                    let connect_state = Arc::clone(&state);
                    let connect_config = config.clone();
                    let connects = Arc::clone(&connects);
                    state
                        .get_or_insert_ssh_session("session-1", move || async move {
                            connects.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            open_connection(&connect_state, &connect_config).await
                        })
                        .await
                        .expect("cached ssh session")
                })
            })
            .collect();

        let sessions: Vec<SharedSshSession> = {
            let mut sessions = Vec::new();
            for handle in handles {
                sessions.push(handle.await.expect("join"));
            }
            sessions
        };

        assert_eq!(connects.load(Ordering::SeqCst), 1);
        for session in &sessions {
            assert!(Arc::ptr_eq(session, &sessions[0]));
        }
    }

    /// Closing a tab mid-handshake must not leave an orphan connection behind that
    /// nothing will ever close, nor let the late connection resurrect the cache.
    #[tokio::test]
    async fn connection_finished_after_session_removal_is_not_cached() {
        let state = Arc::new(temp_state("ssh-removed-midconnect"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));

        let connect_state = Arc::clone(&state);
        let connect_config = config.clone();
        let result = state
            .get_or_insert_ssh_session("session-1", move || async move {
                connect_state
                    .remove_session("session-1")
                    .expect("remove shell");
                open_connection(&connect_state, &connect_config).await
            })
            .await;

        assert!(matches!(result, Err(AppError::NotFound(_))));
        assert!(!state.has_ssh_session("session-1"));
    }

    /// A caller queued behind another tab's handshake must not start a fresh
    /// handshake after the tab is closed, even if it already read the tab token.
    #[tokio::test]
    async fn waiting_callers_do_not_start_a_handshake_after_removal() {
        let state = Arc::new(temp_state("ssh-close-wait"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));

        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();

        let gate_state = Arc::clone(&state);
        let gate_config = config.clone();
        let first = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                state
                    .get_or_insert_ssh_session("session-1", move || async move {
                        let _ = started_tx.send(());
                        let _ = release_rx.await;
                        open_connection(&gate_state, &gate_config).await
                    })
                    .await
            }
        });
        started_rx.await.expect("first handshake started");

        // Second caller queues behind the per-tab connect lock.
        let waiter = tokio::spawn({
            let state = Arc::clone(&state);
            let config = config.clone();
            async move {
                let connect_state = Arc::clone(&state);
                let connect_config = config.clone();
                state
                    .get_or_insert_ssh_session("session-1", move || async move {
                        open_connection(&connect_state, &connect_config).await
                    })
                    .await
            }
        });
        // Let the waiter reach the lock wait before the tab disappears.
        tokio::task::yield_now().await;

        state.remove_session("session-1").expect("remove shell");
        let _ = release_tx.send(());

        let first_result = first.await.expect("join first");
        let waiter_result = waiter.await.expect("join waiter");
        assert!(matches!(first_result, Err(AppError::NotFound(_))));
        assert!(matches!(waiter_result, Err(AppError::NotFound(_))));
        assert!(!state.has_ssh_session("session-1"));
    }

    /// A tab that is closed and immediately re-created must get a new connection,
    /// not the one that was shut down with the previous incarnation.
    #[tokio::test]
    async fn connection_is_not_reused_across_tab_recreation() {
        let state = Arc::new(temp_state("ssh-recreate"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));

        let first = state
            .get_or_insert_ssh_session("session-1", connector!(state, config))
            .await
            .expect("first ssh session");
        state.remove_session("session-1").expect("remove shell");
        assert!(
            first.is_closed(),
            "removal must close the cached connection"
        );

        state.put_session(shell_session("session-1"));
        let second = state
            .get_or_insert_ssh_session("session-1", connector!(state, config))
            .await
            .expect("second ssh session");
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn ssh_session_is_reused_for_the_same_shell_session() {
        let state = Arc::new(temp_state("ssh-reuse"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));

        let first = state
            .get_or_insert_ssh_session("session-1", connector!(state, config))
            .await
            .expect("first ssh session");
        let second = state
            .get_or_insert_ssh_session("session-1", || async {
                Err::<Connection, AppError>(AppError::Runtime(
                    "cached session must not reconnect".to_string(),
                ))
            })
            .await
            .expect("second ssh session");

        assert!(Arc::ptr_eq(&first, &second));
    }

    /// A connection seeded by the PTY worker is what later operations reuse.
    #[tokio::test]
    async fn put_ssh_session_seeds_the_cache_for_later_operations() {
        let state = Arc::new(temp_state("ssh-put-seed"));
        let fixture = TestFixture::start(&state).await;
        state.put_session(shell_session("session-1"));

        let seeded = Arc::new(
            open_connection(&state, &fixture.config)
                .await
                .expect("seeded"),
        );
        state
            .put_ssh_session("session-1", Arc::clone(&seeded))
            .expect("seed connection");
        assert!(state.has_ssh_session("session-1"));

        let reused = state
            .get_or_insert_ssh_session("session-1", || async {
                Err::<Connection, AppError>(AppError::Runtime(
                    "seeded session must not reconnect".to_string(),
                ))
            })
            .await
            .expect("seeded ssh session");
        assert!(Arc::ptr_eq(&reused, &seeded));
    }

    /// `put_session` must come first: seeding a connection for an unknown or
    /// already-closed tab is rejected and never populates the cache.
    #[tokio::test]
    async fn put_ssh_session_rejects_unknown_and_closed_tabs() {
        let state = Arc::new(temp_state("ssh-put-missing"));
        let fixture = TestFixture::start(&state).await;
        let orphan = Arc::new(
            open_connection(&state, &fixture.config)
                .await
                .expect("orphan"),
        );
        assert!(matches!(
            state.put_ssh_session("session-1", Arc::clone(&orphan)),
            Err(AppError::NotFound(_))
        ));
        assert!(!state.has_ssh_session("session-1"));

        state.put_session(shell_session("session-1"));
        state.remove_session("session-1").expect("remove shell");
        let late = Arc::new(
            open_connection(&state, &fixture.config)
                .await
                .expect("late"),
        );
        assert!(matches!(
            state.put_ssh_session("session-1", late),
            Err(AppError::NotFound(_))
        ));
        assert!(!state.has_ssh_session("session-1"));
    }

    /// Removing a tab closes the cached connection rather than only forgetting it.
    #[tokio::test]
    async fn remove_session_shuts_down_cached_ssh_session() {
        let state = Arc::new(temp_state("ssh-cleanup"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));
        let cached = state
            .get_or_insert_ssh_session("session-1", connector!(state, config))
            .await
            .expect("cached ssh session");

        state.remove_session("session-1").expect("remove shell");

        assert!(cached.is_closed(), "removal must shut the connection down");
        assert!(!state.has_ssh_session("session-1"));
    }

    #[tokio::test]
    async fn evict_ssh_session_only_drops_the_observed_connection() {
        let state = Arc::new(temp_state("ssh-evict"));
        let fixture = TestFixture::start(&state).await;
        let config = fixture.config.clone();
        state.put_session(shell_session("session-1"));

        let stale = state
            .get_or_insert_ssh_session("session-1", connector!(state, config))
            .await
            .expect("stale ssh session");

        assert!(state.evict_ssh_session("session-1", &stale));
        assert!(!state.has_ssh_session("session-1"));
        assert!(
            stale.is_closed(),
            "eviction must shut the stale connection down"
        );

        let fresh = state
            .get_or_insert_ssh_session("session-1", connector!(state, config))
            .await
            .expect("fresh ssh session");
        assert!(!Arc::ptr_eq(&stale, &fresh));

        // A late caller still holding the stale handle must not evict the fresh connection.
        assert!(!state.evict_ssh_session("session-1", &stale));
        assert!(state.has_ssh_session("session-1"));
        assert!(!fresh.is_closed());
    }

    #[test]
    fn shell_session_token_is_created_once_across_updates() {
        let state = temp_state("session-token");
        assert!(matches!(
            state.shell_session_token("session-1"),
            Err(AppError::NotFound(_))
        ));

        state.put_session(shell_session("session-1"));
        let token = state
            .shell_session_token("session-1")
            .expect("token for live session");
        assert!(!token.is_cancelled());

        // Updates (put_session / mutate_session) must not replace the token: the
        // original handle observes a cancel applied to the freshly read one.
        state.put_session(shell_session_created_at(
            "session-1",
            "2026-09-14T09:00:00.000000000+00:00",
        ));
        state
            .mutate_session("session-1", |session| {
                session.current_dir = "/tmp".to_string();
            })
            .expect("mutate session");
        let after_updates = state.shell_session_token("session-1").expect("token");
        after_updates.cancel();
        assert!(
            token.is_cancelled(),
            "updates must keep the same token instance"
        );
    }

    #[test]
    fn remove_session_cancels_the_shell_session_token() {
        let state = temp_state("session-token-remove");
        state.put_session(shell_session("session-1"));
        let token = state
            .shell_session_token("session-1")
            .expect("token for live session");
        assert!(!token.is_cancelled());

        state.remove_session("session-1").expect("remove session");

        assert!(token.is_cancelled(), "removal must cancel the tab token");
        assert!(matches!(
            state.shell_session_token("session-1"),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn shell_connection_cancellation_preserves_pre_cancel() {
        let state = temp_state("conn-cancel");

        let active = state.begin_shell_connection("req-1");
        assert!(!active.is_cancelled());
        assert!(!state.is_shell_connection_cancelled("req-1"));

        assert!(state.cancel_shell_connection("req-1"));
        assert!(active.is_cancelled());
        assert!(state.is_shell_connection_cancelled("req-1"));

        state.clear_shell_connection("req-1");
        assert!(!state.is_shell_connection_cancelled("req-1"));

        // Cancelling before begin leaves the returned token pre-cancelled.
        assert!(!state.cancel_shell_connection("req-2"));
        let pre = state.begin_shell_connection("req-2");
        assert!(pre.is_cancelled());
        assert!(state.is_shell_connection_cancelled("req-2"));
    }

    #[test]
    fn sftp_transfer_cancellation_preserves_pre_cancel() {
        let state = temp_state("sftp-cancel");

        let active = state.begin_sftp_transfer("transfer-1");
        assert!(!active.is_cancelled());
        assert!(!state.is_sftp_transfer_cancelled("transfer-1"));

        assert!(state.cancel_sftp_transfer("transfer-1"));
        assert!(active.is_cancelled());
        assert!(state.is_sftp_transfer_cancelled("transfer-1"));

        state.clear_sftp_transfer("transfer-1");
        assert!(!state.is_sftp_transfer_cancelled("transfer-1"));

        assert!(!state.cancel_sftp_transfer("transfer-2"));
        let pre = state.begin_sftp_transfer("transfer-2");
        assert!(pre.is_cancelled());
        assert!(state.is_sftp_transfer_cancelled("transfer-2"));
    }

    #[tokio::test]
    async fn pty_channels_forward_input_synchronously_and_close_on_removal() {
        let state = temp_state("pty-channel");
        state.put_session(shell_session("session-1"));
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        state.put_pty_channel("session-1".to_string(), sender);

        // Synchronous send: no `.await` required on the command path.
        state
            .send_pty_command("session-1", PtyCommand::Input("ls\n".to_string()))
            .expect("send input");
        match receiver.recv().await {
            Some(PtyCommand::Input(input)) => assert_eq!(input, "ls\n"),
            other => panic!("expected forwarded input, got {other:?}"),
        }

        // Replacing the channel asks the previous worker to stop.
        let (replacement, mut replacement_rx) = tokio::sync::mpsc::unbounded_channel();
        state.put_pty_channel("session-1".to_string(), replacement);
        assert!(matches!(receiver.recv().await, Some(PtyCommand::Close)));

        assert!(matches!(
            state.send_pty_command("missing", PtyCommand::Close),
            Err(AppError::NotFound(_))
        ));

        // Removing asks the current worker to stop too.
        state.remove_pty_channel("session-1");
        assert!(matches!(
            replacement_rx.recv().await,
            Some(PtyCommand::Close)
        ));
    }

    /// A tab can be reopened while its previous worker is still winding down.
    /// That outgoing worker must not unregister the channel its replacement just
    /// registered, or the reopened PTY would be dead on arrival.
    #[tokio::test]
    async fn a_replaced_pty_worker_does_not_unregister_its_successor() {
        let state = temp_state("pty-generation");
        state.put_session(shell_session("session-1"));

        let (first, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
        let first_generation = state.put_pty_channel("session-1".to_string(), first);

        // The reopen: a second worker takes over the same tab.
        let (second, mut second_rx) = tokio::sync::mpsc::unbounded_channel();
        let second_generation = state.put_pty_channel("session-1".to_string(), second);
        assert_ne!(first_generation, second_generation);
        assert!(matches!(first_rx.recv().await, Some(PtyCommand::Close)));

        // The outgoing worker exits and tries to clean up after itself.
        state.remove_pty_channel_if_current("session-1", first_generation);

        // The replacement is still the live channel: input reaches it, and it was
        // never told to stop.
        state
            .send_pty_command("session-1", PtyCommand::Input("ls\n".to_string()))
            .expect("the replacement channel must survive the old worker's exit");
        assert!(matches!(
            second_rx.recv().await,
            Some(PtyCommand::Input(input)) if input == "ls\n"
        ));

        // The current worker's own cleanup does unregister it.
        state.remove_pty_channel_if_current("session-1", second_generation);
        assert!(matches!(second_rx.recv().await, Some(PtyCommand::Close)));
        assert!(matches!(
            state.send_pty_command("session-1", PtyCommand::Close),
            Err(AppError::NotFound(_))
        ));
    }

    /// A PTY worker seeded concurrently with tab teardown must not leave a channel
    /// registered for a session that is already gone.
    #[tokio::test]
    async fn put_pty_channel_is_ignored_after_the_tab_is_removed() {
        let state = temp_state("pty-channel-closed");
        state.put_session(shell_session("session-1"));
        state.remove_session("session-1").expect("remove shell");

        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        state.put_pty_channel("session-1".to_string(), sender);

        // The rejected worker is told to stop so its receiver ends and it exits.
        assert!(matches!(receiver.recv().await, Some(PtyCommand::Close)));
        assert!(matches!(
            state.send_pty_command("session-1", PtyCommand::Close),
            Err(AppError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn ki_responses_are_delivered_over_oneshot() {
        let state = temp_state("ki-pending");
        let (sender, receiver) = oneshot::channel();
        state.put_ki_pending("challenge-1", sender);

        state
            .respond_ki("challenge-1", vec!["secret".to_string()])
            .expect("respond");
        assert_eq!(
            receiver.await.expect("response"),
            vec!["secret".to_string()]
        );

        // A challenge is one-shot: responding twice is a NotFound.
        assert!(matches!(
            state.respond_ki("challenge-1", Vec::new()),
            Err(AppError::NotFound(_))
        ));
    }
}
