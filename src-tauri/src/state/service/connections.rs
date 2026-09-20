//! Shell connection-attempt cancellation markers on `AppState`: the
//! request-scoped registry that lets the UI cancel a pending TCP connect.

use tokio_util::sync::CancellationToken;

use crate::state::model::AppState;

impl AppState {
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
}
