//! Shared constants for the SFTP domain.
//!
//! Every constant that used to be declared inline in `service/ops.rs` and
//! `service/mod.rs` lives here so the business files stay free of const
//! definitions. `EXTENSION_ID` stays `pub` because it is referenced from
//! other domains (via the `service::EXTENSION_ID` re-export); the
//! cancellation message consts stay `pub(crate)` because the moved tests
//! assert them through `ops::`.

use std::time::Duration;

pub(crate) const SFTP_TRANSFER_EVENT: &str = "sftp-transfer";
pub(crate) const SFTP_TRANSFER_CHUNK_BYTES: usize = 64 * 1024;
pub(crate) const SFTP_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(200);
/// Upper bound for the server's subsystem-request reply.
pub(crate) const SFTP_SUBSYSTEM_REPLY_TIMEOUT: Duration = Duration::from_secs(15);
/// Cleanup after cancellation must not re-block: closing a handle or unlinking a
/// partial file is best-effort and bounded.
pub(crate) const SFTP_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
/// Message preserved from the synchronous implementation for transfer cancellations.
pub(crate) const SFTP_TRANSFER_CANCELLED_MESSAGE: &str = "transfer cancelled by user";
pub(crate) const SFTP_OPERATION_CANCELLED_MESSAGE: &str = "SFTP operation cancelled by user";

/// Extension id from `extensions/builtin.json`.
pub const EXTENSION_ID: &str = "eshell.sftp";
