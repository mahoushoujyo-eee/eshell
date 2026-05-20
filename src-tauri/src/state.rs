use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, RwLock};

use crate::error::{AppError, AppResult};
use crate::models::{ServerStatus, ShellSession};
use crate::ops_agent::infrastructure::agent_trace_store::OpsAgentTraceStore;
use crate::ops_agent::infrastructure::attachments::OpsAgentAttachmentStore;
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunRegistry;
use crate::ops_agent::infrastructure::store::OpsAgentStore;
use crate::ops_agent::tools::{default_ops_agent_tool_registry, OpsAgentToolRegistry};
use crate::storage::Storage;
use ssh2::Session;

pub type SharedSshSession = Arc<Mutex<Session>>;

#[derive(Debug, Clone)]
pub enum PtyCommand {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Close,
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
    sessions: RwLock<HashMap<String, ShellSession>>,
    ssh_sessions: RwLock<HashMap<String, SharedSshSession>>,
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
            sessions: RwLock::new(HashMap::new()),
            ssh_sessions: RwLock::new(HashMap::new()),
            status_cache: RwLock::new(HashMap::new()),
            pty_channels: RwLock::new(HashMap::new()),
            shell_connection_cancellations: RwLock::new(HashMap::new()),
            sftp_transfer_cancellations: RwLock::new(HashMap::new()),
            ki_pending: RwLock::new(HashMap::new()),
        })
    }

    /// Returns all active shell sessions.
    pub fn list_sessions(&self) -> Vec<ShellSession> {
        self.sessions
            .read()
            .expect("session lock poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// Stores or updates a shell session in the runtime registry.
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

    /// Returns the cached SSH operation session for a shell session, creating it once when absent.
    pub fn get_or_insert_ssh_session<F>(
        &self,
        session_id: &str,
        connect: F,
    ) -> AppResult<SharedSshSession>
    where
        F: FnOnce() -> AppResult<Session>,
    {
        if let Some(session) = self
            .ssh_sessions
            .read()
            .expect("ssh session lock poisoned")
            .get(session_id)
            .cloned()
        {
            return Ok(session);
        }

        let mut guard = self
            .ssh_sessions
            .write()
            .expect("ssh session lock poisoned");
        if let Some(session) = guard.get(session_id).cloned() {
            return Ok(session);
        }

        let session = Arc::new(Mutex::new(connect()?));
        guard.insert(session_id.to_string(), Arc::clone(&session));
        Ok(session)
    }

    /// Removes the cached SSH operation session for one shell session.
    pub fn remove_ssh_session(&self, session_id: &str) {
        self.ssh_sessions
            .write()
            .expect("ssh session lock poisoned")
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
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_state(name: &str) -> AppState {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("eshell-state-{name}-{nonce}"));
        AppState::new(root).expect("create app state")
    }

    fn shell_session(id: &str) -> ShellSession {
        let now = now_rfc3339();
        ShellSession {
            id: id.to_string(),
            config_id: "config-1".to_string(),
            config_name: "Test host".to_string(),
            current_dir: "/home/test".to_string(),
            last_output: String::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn ssh_operation_session_is_reused_for_the_same_shell_session() {
        let state = temp_state("ssh-reuse");
        state.put_session(shell_session("session-1"));

        let first = state
            .get_or_insert_ssh_session("session-1", || Ok(Session::new()?))
            .expect("first ssh session");
        let second = state
            .get_or_insert_ssh_session("session-1", || Ok(Session::new()?))
            .expect("second ssh session");

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn remove_session_drops_cached_ssh_operation_session() {
        let state = temp_state("ssh-cleanup");
        state.put_session(shell_session("session-1"));
        state
            .get_or_insert_ssh_session("session-1", || Ok(Session::new()?))
            .expect("cached ssh session");

        state.remove_session("session-1").expect("remove shell");

        assert!(!state.has_ssh_session("session-1"));
    }
}
