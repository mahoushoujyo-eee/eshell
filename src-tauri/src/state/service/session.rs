//! Shell-session bookkeeping on `AppState`: the tab registry, its ordering,
//! per-tab cancellation tokens and the teardown ordering that ties every
//! per-tab cache to `remove_session`.

use std::collections::HashMap;

use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::domain::ssh::model::session_model::ShellSession;
use crate::state::model::AppState;

impl AppState {
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

        // The server-monitor plugin drops its cache entry for the closed tab.
        crate::domain::monitor::service::on_session_removed(self, session_id);
        self.remove_ssh_session(session_id);
        Ok(())
    }

    /// Read access to the sessions map for plugin state that must validate
    /// liveness under the same read lock the core uses.
    ///
    /// This is the narrow bridge: plugins never re-implement session
    /// bookkeeping, they borrow the core's map for their insert guards.
    pub(crate) fn sessions_read(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<String, ShellSession>> {
        self.sessions.read().expect("session lock poisoned")
    }
}
