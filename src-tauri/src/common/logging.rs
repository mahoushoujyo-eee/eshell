//! Append-only debug logs under the storage root.
//!
//! Two logs exist today:
//! - `server_ops_debug.log`: SSH channel/PTY/SFTP diagnostics (this module).
//! - `ops_agent_debug.log`: agent chat diagnostics, appended by
//!   `domain::ops_agent::infrastructure::logging`, which keeps its own richer
//!   record shape.

use std::fs::OpenOptions;
use std::io::Write;

use crate::state::AppState;
use crate::common::time::now_rfc3339;

/// Appends one line to `server_ops_debug.log` under the storage root.
///
/// Best-effort: a failing log write is silently dropped, because logging must
/// never turn an operational failure into a different one.
pub fn append_server_ops_debug_log(
    state: &AppState,
    event: &str,
    session_id: &str,
    detail: impl AsRef<str>,
) {
    let path = state.storage.data_dir().join("server_ops_debug.log");
    let line = format!(
        "{} [{}] session_id={} {}\n",
        now_rfc3339(),
        event,
        session_id,
        detail.as_ref()
    );
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}
