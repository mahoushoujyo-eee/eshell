use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::models::{ServerStatus, ShellSession};
use crate::storage::Storage;

/// Shared application state managed by Tauri.
///
/// Design goals:
/// - Keep persistent data concerns in `Storage`.
/// - Keep runtime-only data (shell sessions, status cache) in memory.
/// - Keep core logic testable by not tightly coupling service code to Tauri types.
pub struct AppState {
    pub storage: Storage,
    sessions: RwLock<HashMap<String, ShellSession>>,
    status_cache: RwLock<HashMap<String, ServerStatus>>,
}

impl AppState {
    /// Creates a fully initialized state object backed by a storage root path.
    pub fn new(storage_root: PathBuf) -> AppResult<Self> {
        Ok(Self {
            storage: Storage::new(storage_root)?,
            sessions: RwLock::new(HashMap::new()),
            status_cache: RwLock::new(HashMap::new()),
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
