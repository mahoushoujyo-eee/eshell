//! Agent domain: everything about driving AI agents.
//!
//! External coding agents (Codex, Claude Code, OpenCode) run as subprocesses
//! over the official ACP SDK; this domain owns that integration end to end:
//!
//! - `model.rs` — spawn configuration, session history records, project rows
//!   and the wire inputs.
//! - `service/` — the ACP session runner, the project registry and the
//!   loopback MCP bridge that injects eShell's tools into agent sessions.
//! - `command.rs` — the `acp_*` Tauri command surface.
//! - `consts.rs` — stream stage markers, storage file names, protocol limits.

pub(crate) mod consts;
pub mod model;
pub(crate) mod service;

pub mod command;

#[cfg(test)]
mod tests;

