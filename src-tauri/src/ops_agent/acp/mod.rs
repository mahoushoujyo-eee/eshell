//! ACP (Agent Client Protocol) integration built on the official
//! [`agent_client_protocol`](https://docs.rs/agent-client-protocol) SDK.
//!
//! External coding agents (Codex via `codex-acp` first) run as subprocesses;
//! the SDK handles ndjson JSON-RPC framing, spawn (including the Windows
//! no-window flag), dispatch, and cancellation plumbing. This module only
//! bridges typed ACP events onto the `acp-agent-stream` Tauri event and
//! exposes the command surface.

pub mod client;
pub mod commands;
