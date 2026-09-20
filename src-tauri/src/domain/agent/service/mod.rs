//! Agent domain services.
//!
//! - [`acp_client`]: the ACP session runner that spawns and drives the
//!   external agent subprocess.
//! - [`projects`]: the local project registry persisted as
//!   `.eshell-data/projects.json`.
//! - [`mcp_bridge`]: the loopback MCP endpoint injecting eShell's tools into
//!   ACP agent sessions.

pub(crate) mod acp_client;
pub(crate) mod mcp_bridge;
pub(crate) mod projects;
