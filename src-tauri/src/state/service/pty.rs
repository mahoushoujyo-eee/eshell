//! PTY control-channel registry on `AppState`: per-tab worker channels,
//! generation tagging and the replacement-safe unregister.

use tokio::sync::mpsc::UnboundedSender;

use crate::common::error::{AppError, AppResult};
use crate::state::model::{AppState, PtyCommand};

impl AppState {
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
        let generation = self.pty_generations.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
        let mut guard = self
            .pty_channels
            .write()
            .expect("pty channel lock poisoned");
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
}
