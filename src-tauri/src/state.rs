use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, RwLock};

use crate::error::{AppError, AppResult};
use crate::models::{ServerStatus, ShellSession};
use crate::ops_agent::acp::commands::AcpAgentRegistry;
use crate::ops_agent::infrastructure::agent_trace_store::OpsAgentTraceStore;
use crate::ops_agent::infrastructure::attachments::OpsAgentAttachmentStore;
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunRegistry;
use crate::ops_agent::infrastructure::store::OpsAgentStore;
use crate::ops_agent::tools::{default_ops_agent_tool_registry, OpsAgentToolRegistry};
use crate::storage::Storage;
use ssh2::Session;

pub type SharedSshSession = Arc<Mutex<Session>>;

/// Purpose of a cached SSH session bound to one shell tab.
///
/// Each kind is a separate long-lived connection so a slow SFTP transfer never
/// blocks command execution on the same tab (and vice versa), while the total
/// number of connections per tab stays bounded instead of growing per command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SshSessionKind {
    /// Shared by SFTP browsing / editing and server status polling.
    Operation,
    /// Dedicated to non-interactive command execution (`execute_command`).
    Exec,
}

/// Cache key for one connection: which shell tab it belongs to, and what it is for.
type SshSessionKey = (String, SshSessionKind);

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
    ssh_sessions: RwLock<HashMap<SshSessionKey, SharedSshSession>>,
    /// One lock per cache key, held while that key's connection is being
    /// established. Connecting must not hold `ssh_sessions` itself: a handshake
    /// takes seconds, and that map is shared by every tab.
    ssh_connect_locks: Mutex<HashMap<SshSessionKey, Arc<Mutex<()>>>>,
    status_cache: RwLock<HashMap<String, ServerStatus>>,
    pty_channels: RwLock<HashMap<String, Sender<PtyCommand>>>,
    shell_connection_cancellations: RwLock<HashMap<String, bool>>,
    sftp_transfer_cancellations: RwLock<HashMap<String, bool>>,
    ki_pending: RwLock<HashMap<String, Sender<Vec<String>>>>,
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
        *self
            .mcp_bridge
            .write()
            .expect("mcp bridge lock poisoned") = Some(info);
    }

    /// Returns the local MCP bridge endpoint, if it started successfully.
    pub fn mcp_bridge(&self) -> Option<McpBridgeInfo> {
        self.mcp_bridge
            .read()
            .expect("mcp bridge lock poisoned")
            .clone()
    }

    pub fn put_session(&self, session: ShellSession) {
        self.sessions
            .write()
            .expect("session lock poisoned")
            .insert(session.id.clone(), session);
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

    /// Removes a shell session and any stale cache bound to that session.
    pub fn remove_session(&self, session_id: &str) -> AppResult<()> {
        self.remove_pty_channel(session_id);

        let removed = self
            .sessions
            .write()
            .expect("session lock poisoned")
            .remove(session_id);
        if removed.is_none() {
            return Err(AppError::NotFound(format!("shell session {session_id}")));
        }
        self.status_cache
            .write()
            .expect("status cache lock poisoned")
            .remove(session_id);
        self.remove_ssh_session(session_id);
        Ok(())
    }

    /// Returns the cached SSH session of one kind for a shell session, creating it once when absent.
    ///
    /// `connect` runs without holding `ssh_sessions`, because establishing an SSH
    /// connection takes seconds (TCP + handshake + auth) and that map is shared by
    /// every open tab. Holding it across the handshake stalled every other tab's
    /// SFTP, status and command traffic until the new connection came up.
    ///
    /// Concurrent callers for the *same* key still take turns on a per-key lock, so
    /// a burst of operations on a fresh tab opens one connection rather than one per
    /// caller. Callers for different keys never block each other.
    pub fn get_or_insert_ssh_session<F>(
        &self,
        session_id: &str,
        kind: SshSessionKind,
        connect: F,
    ) -> AppResult<SharedSshSession>
    where
        F: FnOnce() -> AppResult<Session>,
    {
        let key = (session_id.to_string(), kind);
        if let Some(session) = self.cached_ssh_session(&key) {
            return Ok(session);
        }

        let connect_lock = self.ssh_connect_lock(&key);
        let _connect_guard = connect_lock
            .lock()
            .map_err(|_| AppError::Runtime("ssh connect lock poisoned".to_string()))?;

        // Another caller may have finished connecting for this key while we waited.
        if let Some(session) = self.cached_ssh_session(&key) {
            return Ok(session);
        }

        let session = Arc::new(Mutex::new(connect()?));

        // The tab may have been closed during the handshake. Dropping the freshly
        // opened connection here keeps `remove_session` authoritative; inserting it
        // would leak a connection nothing ever closes.
        if !self.has_shell_session(session_id) {
            return Err(AppError::NotFound(format!("shell session {session_id}")));
        }

        self.ssh_sessions
            .write()
            .expect("ssh session lock poisoned")
            .insert(key, Arc::clone(&session));
        Ok(session)
    }

    fn cached_ssh_session(&self, key: &SshSessionKey) -> Option<SharedSshSession> {
        self.ssh_sessions
            .read()
            .expect("ssh session lock poisoned")
            .get(key)
            .cloned()
    }

    fn ssh_connect_lock(&self, key: &SshSessionKey) -> Arc<Mutex<()>> {
        let mut guard = self
            .ssh_connect_locks
            .lock()
            .expect("ssh connect lock registry poisoned");
        Arc::clone(guard.entry(key.clone()).or_default())
    }

    fn has_shell_session(&self, session_id: &str) -> bool {
        self.sessions
            .read()
            .expect("session lock poisoned")
            .contains_key(session_id)
    }

    /// Drops one cached SSH session after its transport turned out to be dead.
    ///
    /// Only evicts when the cache still holds the very same connection, so a
    /// caller that observed a stale connection never throws away a fresh one
    /// that another caller has already re-established in the meantime.
    /// Returns whether an entry was removed.
    pub fn evict_ssh_session(
        &self,
        session_id: &str,
        kind: SshSessionKind,
        stale: &SharedSshSession,
    ) -> bool {
        let key = (session_id.to_string(), kind);
        let mut guard = self
            .ssh_sessions
            .write()
            .expect("ssh session lock poisoned");
        match guard.get(&key) {
            Some(current) if Arc::ptr_eq(current, stale) => {
                guard.remove(&key);
                true
            }
            _ => false,
        }
    }

    /// Removes every cached SSH session (all kinds) for one shell session.
    pub fn remove_ssh_session(&self, session_id: &str) {
        self.ssh_sessions
            .write()
            .expect("ssh session lock poisoned")
            .retain(|(cached_id, _), _| cached_id != session_id);
        self.ssh_connect_locks
            .lock()
            .expect("ssh connect lock registry poisoned")
            .retain(|(cached_id, _), _| cached_id != session_id);
    }

    #[cfg(test)]
    pub fn has_ssh_session(&self, session_id: &str, kind: SshSessionKind) -> bool {
        self.ssh_sessions
            .read()
            .expect("ssh session lock poisoned")
            .contains_key(&(session_id.to_string(), kind))
    }

    /// Registers or replaces PTY control channel for one shell session.
    pub fn put_pty_channel(&self, session_id: String, sender: Sender<PtyCommand>) {
        if let Some(previous) = self
            .pty_channels
            .write()
            .expect("pty channel lock poisoned")
            .insert(session_id, sender)
        {
            let _ = previous.send(PtyCommand::Close);
        }
    }

    /// Sends PTY control message to one shell session worker.
    pub fn send_pty_command(&self, session_id: &str, command: PtyCommand) -> AppResult<()> {
        let sender = self
            .pty_channels
            .read()
            .expect("pty channel lock poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("pty session {session_id}")))?;
        sender.send(command).map_err(|err| {
            AppError::Runtime(format!("pty worker channel closed for {session_id}: {err}"))
        })
    }

    /// Unregisters PTY channel and asks worker to stop.
    pub fn remove_pty_channel(&self, session_id: &str) {
        if let Some(sender) = self
            .pty_channels
            .write()
            .expect("pty channel lock poisoned")
            .remove(session_id)
        {
            let _ = sender.send(PtyCommand::Close);
        }
    }

    /// Marks one shell connection attempt as active unless it was already pre-cancelled.
    pub fn begin_shell_connection(&self, request_id: &str) {
        self.shell_connection_cancellations
            .write()
            .expect("shell connection cancellation lock poisoned")
            .entry(request_id.to_string())
            .or_insert(false);
    }

    /// Requests cancellation for a shell connection attempt.
    pub fn cancel_shell_connection(&self, request_id: &str) -> bool {
        let mut guard = self
            .shell_connection_cancellations
            .write()
            .expect("shell connection cancellation lock poisoned");
        let existed = guard.contains_key(request_id);
        guard.insert(request_id.to_string(), true);
        existed
    }

    /// Checks whether a shell connection attempt is cancelled.
    pub fn is_shell_connection_cancelled(&self, request_id: &str) -> bool {
        self.shell_connection_cancellations
            .read()
            .expect("shell connection cancellation lock poisoned")
            .get(request_id)
            .copied()
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
    pub fn put_cached_status(&self, session_id: &str, status: ServerStatus) {
        self.status_cache
            .write()
            .expect("status cache lock poisoned")
            .insert(session_id.to_string(), status);
    }

    /// Marks one transfer as active unless it was already pre-cancelled.
    pub fn begin_sftp_transfer(&self, transfer_id: &str) {
        self.sftp_transfer_cancellations
            .write()
            .expect("sftp cancellation lock poisoned")
            .entry(transfer_id.to_string())
            .or_insert(false);
    }

    /// Requests cancellation for a transfer.
    pub fn cancel_sftp_transfer(&self, transfer_id: &str) -> bool {
        let mut guard = self
            .sftp_transfer_cancellations
            .write()
            .expect("sftp cancellation lock poisoned");
        let existed = guard.contains_key(transfer_id);
        guard.insert(transfer_id.to_string(), true);
        existed
    }

    /// Checks whether transfer is cancelled.
    pub fn is_sftp_transfer_cancelled(&self, transfer_id: &str) -> bool {
        self.sftp_transfer_cancellations
            .read()
            .expect("sftp cancellation lock poisoned")
            .get(transfer_id)
            .copied()
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
    pub fn put_ki_pending(&self, request_id: &str, sender: Sender<Vec<String>>) {
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
    use crate::models::now_rfc3339;
    use ssh2::Session;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    #[test]
    fn connecting_one_tab_does_not_block_another_tab() {
        let state = Arc::new(temp_state("ssh-parallel-connect"));
        state.put_session(shell_session("session-1"));
        state.put_session(shell_session("session-2"));

        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let slow = {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                state.get_or_insert_ssh_session("session-1", SshSessionKind::Operation, || {
                    started_tx.send(()).expect("signal connect start");
                    release_rx.recv().expect("wait for release");
                    Ok(Session::new()?)
                })
            })
        };

        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("slow connect started");

        // Run the second tab's connect on its own thread so a regression shows up as
        // a clean timeout instead of hanging the whole test binary.
        let (done_tx, done_rx) = mpsc::channel();
        {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                let result =
                    state.get_or_insert_ssh_session("session-2", SshSessionKind::Operation, || {
                        Ok(Session::new()?)
                    });
                let _ = done_tx.send(result.is_ok());
            });
        }

        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(5)).ok(),
            Some(true),
            "a tab must be able to connect while another tab is still handshaking"
        );

        release_tx.send(()).expect("release slow connect");
        slow.join().expect("join slow connect").expect("connect");
    }

    /// A fresh tab fires several operations at once (SFTP listing, status poll).
    /// They must share one handshake instead of racing into several connections.
    #[test]
    fn concurrent_callers_for_one_key_open_a_single_connection() {
        let state = Arc::new(temp_state("ssh-single-connect"));
        state.put_session(shell_session("session-1"));
        let connects = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let state = Arc::clone(&state);
                let connects = Arc::clone(&connects);
                thread::spawn(move || {
                    state
                        .get_or_insert_ssh_session("session-1", SshSessionKind::Operation, || {
                            connects.fetch_add(1, Ordering::SeqCst);
                            thread::sleep(Duration::from_millis(50));
                            Ok(Session::new()?)
                        })
                        .expect("cached ssh session")
                })
            })
            .collect();

        let sessions: Vec<SharedSshSession> = handles
            .into_iter()
            .map(|handle| handle.join().expect("join"))
            .collect();

        assert_eq!(connects.load(Ordering::SeqCst), 1);
        for session in &sessions {
            assert!(Arc::ptr_eq(session, &sessions[0]));
        }
    }

    /// Closing a tab mid-handshake must not leave an orphan connection behind that
    /// nothing will ever close.
    #[test]
    fn connection_finished_after_session_removal_is_not_cached() {
        let state = temp_state("ssh-removed-midconnect");
        state.put_session(shell_session("session-1"));

        let result = state.get_or_insert_ssh_session("session-1", SshSessionKind::Exec, || {
            state.remove_session("session-1").expect("remove shell");
            Ok(Session::new()?)
        });

        assert!(matches!(result, Err(AppError::NotFound(_))));
        assert!(!state.has_ssh_session("session-1", SshSessionKind::Exec));
    }

    #[test]
    fn ssh_operation_session_is_reused_for_the_same_shell_session() {
        let state = temp_state("ssh-reuse");
        state.put_session(shell_session("session-1"));

        let first = state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Operation, || {
                Ok(Session::new()?)
            })
            .expect("first ssh session");
        let second = state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Operation, || {
                Ok(Session::new()?)
            })
            .expect("second ssh session");

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn ssh_session_kinds_are_cached_independently() {
        let state = temp_state("ssh-kinds");
        state.put_session(shell_session("session-1"));

        let operation = state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Operation, || {
                Ok(Session::new()?)
            })
            .expect("operation ssh session");
        let exec = state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Exec, || Ok(Session::new()?))
            .expect("exec ssh session");

        assert!(!Arc::ptr_eq(&operation, &exec));
        assert!(state.has_ssh_session("session-1", SshSessionKind::Operation));
        assert!(state.has_ssh_session("session-1", SshSessionKind::Exec));
    }

    #[test]
    fn evict_ssh_session_only_drops_the_observed_connection() {
        let state = temp_state("ssh-evict");
        state.put_session(shell_session("session-1"));

        let stale = state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Exec, || Ok(Session::new()?))
            .expect("stale ssh session");

        assert!(state.evict_ssh_session("session-1", SshSessionKind::Exec, &stale));
        assert!(!state.has_ssh_session("session-1", SshSessionKind::Exec));

        let fresh = state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Exec, || Ok(Session::new()?))
            .expect("fresh ssh session");
        assert!(!Arc::ptr_eq(&stale, &fresh));

        // A late caller still holding the stale handle must not evict the fresh connection.
        assert!(!state.evict_ssh_session("session-1", SshSessionKind::Exec, &stale));
        assert!(state.has_ssh_session("session-1", SshSessionKind::Exec));
    }

    #[test]
    fn remove_session_drops_cached_ssh_operation_session() {
        let state = temp_state("ssh-cleanup");
        state.put_session(shell_session("session-1"));
        state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Operation, || {
                Ok(Session::new()?)
            })
            .expect("cached ssh session");
        state
            .get_or_insert_ssh_session("session-1", SshSessionKind::Exec, || Ok(Session::new()?))
            .expect("cached exec session");

        state.remove_session("session-1").expect("remove shell");

        assert!(!state.has_ssh_session("session-1", SshSessionKind::Operation));
        assert!(!state.has_ssh_session("session-1", SshSessionKind::Exec));
    }
}
