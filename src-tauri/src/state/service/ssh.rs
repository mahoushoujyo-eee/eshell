//! The per-tab SSH connection cache on `AppState`: single-handshake
//! deduplication, stale eviction and close-vs-insert race handling.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;

use crate::common::error::{AppError, AppResult};
use crate::domain::ssh::service::transport::Connection;
use crate::state::model::{AppState, SharedSshSession};

impl AppState {
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

    pub(crate) fn cached_ssh_session(&self, session_id: &str) -> Option<SharedSshSession> {
        self.ssh_sessions
            .read()
            .expect("ssh session lock poisoned")
            .get(session_id)
            .cloned()
    }

    pub(crate) fn ssh_connect_lock(&self, session_id: &str) -> Arc<AsyncMutex<()>> {
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
}
