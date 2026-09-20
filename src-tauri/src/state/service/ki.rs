//! Keyboard-interactive auth challenge registry on `AppState`: pairing the
//! UI's responses with the waiting SSH auth task.

use tokio::sync::oneshot;

use crate::common::error::{AppError, AppResult};
use crate::state::model::AppState;

impl AppState {
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
