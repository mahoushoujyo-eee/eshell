//! Shared constants for the SSH domain.
//!
//! Holds every tuning knob the service layer needs — wire-contract markers, timeouts, keepalive
//! settings and size limits — so the business modules (`service::pty`, `service::session`,
//! `service::transport`) stay free of inline `const` definitions. The two wire-contract markers
//! stay `pub` (the frontend matches them) and are re-exported by `service::transport`; everything
//! else is crate-internal.

use std::time::Duration;

// --- Wire contract (re-exported from `service::transport`) ---

/// Prefix of the runtime error payload the frontend matches to open a host-key trust prompt.
pub const SSH_HOST_KEY_TRUST_REQUIRED_PREFIX: &str = "SSH_HOST_KEY_TRUST_REQUIRED:";
/// Tauri event used to ask the user for keyboard-interactive answers.
pub const SSH_KI_PROMPT_EVENT: &str = "ssh-ki-prompt";

// --- PTY pumping (`service::pty`) ---

pub(crate) const DEFAULT_PTY_COLS: u32 = 120;
pub(crate) const DEFAULT_PTY_ROWS: u32 = 36;
pub(crate) const MAX_SESSION_LAST_OUTPUT_CHARS: usize = 16_000;
pub(crate) const PTY_MAX_COMMANDS_PER_TICK: usize = 64;
pub(crate) const PTY_OUTPUT_INTERVAL: Duration = Duration::from_millis(8);
pub(crate) const PTY_OUTPUT_BATCH_BYTES: usize = 128 * 1024;
/// Bounds the whole PTY setup handshake: `request_pty`, its success reply, `request_shell` and
/// its reply. A server that accepts the channel but never answers would otherwise park the tab
/// forever, since neither request carries a deadline of its own.
pub(crate) const PTY_SETUP_TIMEOUT: Duration = Duration::from_secs(30);

// --- Session command execution (`service::session`) ---

// Commands are not replayed on timeout or output overflow: they may have already
// changed the remote host. PTY sessions and SFTP transfers have no such deadline.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub(crate) const MAX_COMMAND_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_REMOTE_CWD_LEN: usize = 4096;

// --- Transport (`service::transport`). `SSH_CONNECTION_CANCELLED_MESSAGE` is shared with
// `service::session`, which renders the same message when a tab connect is cancelled. ---

pub(crate) const SSH_CONNECTION_CANCELLED_MESSAGE: &str = "SSH connection cancelled by user";
pub(crate) const SSH_CONNECT_TOTAL_TIMEOUT: Duration = Duration::from_secs(45);
pub(crate) const SSH_CONNECT_SLICE_TIMEOUT: Duration = Duration::from_millis(500);
pub(crate) const SSH_CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(25);
pub(crate) const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const SSH_KI_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const SSH_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Interval at which russh sends keepalives. Without these a silently dropped connection is never
/// detected. This is keepalive, not idle GC: the connection is only closed after
/// [`SSH_KEEPALIVE_MAX`] unanswered probes.
pub(crate) const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
pub(crate) const SSH_KEEPALIVE_MAX: usize = 3;
/// Maximum number of configs in a jump chain, including the target itself.
pub(crate) const MAX_JUMP_DEPTH: usize = 4;
