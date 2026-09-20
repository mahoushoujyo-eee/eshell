//! Application-state container.
//!
//! `model.rs` holds the data: the `AppState` struct Tauri manages plus the
//! shared vocabulary types (`SharedSshSession`, `PtyCommand`,
//! `McpBridgeInfo`). `service/` holds the behaviour, one `impl AppState`
//! block per capability. Tests live in `tests.rs`, not in the business
//! files.

pub(crate) mod consts;
pub(crate) mod model;
pub(crate) mod service;

#[cfg(test)]
mod tests;

pub use model::{AppState, McpBridgeInfo, PtyCommand, SharedSshSession};
