//! `AppState` behaviour, split by capability.
//!
//! Each submodule is one `impl AppState` block owning a coherent slice of the
//! container: session bookkeeping, the SSH connection cache, PTY channels,
//! connection-attempt cancellation, extension-runtime access, plugin state and
//! the keyboard-interactive challenge registry. The struct itself and the
//! shared vocabulary types live in [`crate::state::model`].

pub(crate) mod connections;
pub(crate) mod extensions;
pub(crate) mod ki;
pub(crate) mod plugins;
pub(crate) mod pty;
pub(crate) mod session;
pub(crate) mod ssh;
