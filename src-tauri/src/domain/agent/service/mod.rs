//! Agent domain services.
//!
//! - [`acp_client`]: the ACP session runner that spawns and drives the
//!   external agent subprocess.
//! - [`projects`]: the local project registry persisted as
//!   `.eshell-data/projects.json`.
//! - [`mcp_server`]: the transport-agnostic MCP core — tool registry, session
//!   target resolution and JSON-RPC dispatch.
//! - [`mcp_bridge`]: the loopback HTTP transport over that core, injecting
//!   eShell's tools into ACP agent sessions.

pub(crate) mod acp_client;
pub(crate) mod mcp_bridge;
pub(crate) mod mcp_server;
pub(crate) mod projects;
pub(crate) mod runtime_env;
