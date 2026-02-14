use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::models::{ServerStatus, ShellSession};
use crate::ops_agent::store::OpsAgentStore;
use crate::storage::Storage;

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
    sessions: RwLock<HashMap<String, ShellSession>>,
    status_cache: RwLock<HashMap<String, ServerStatus>>,
    pty_channels: RwLock<HashMap<String, Sender<PtyCommand>>>,
}

impl AppState {
    /// Creates a fully initialized state object backed by a storage root path.
    pub fn new(storage_root: PathBuf) -> AppResult<Self> {
        Ok(Self {
            storage: Storage::new(storage_root.clone())?,
            ops_agent: OpsAgentStore::new(storage_root)?,
            sessions: RwLock::new(HashMap::new()),
            status_cache: RwLock::new(HashMap::new()),
            pty_channels: RwLock::new(HashMap::new()),
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
        Ok(())
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
}
