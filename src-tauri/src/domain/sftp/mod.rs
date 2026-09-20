//! SFTP domain: remote file browsing and transfers as a builtin extension.
//!
//! `model.rs` holds the wire structs; `service/` owns the plugin state, the
//! active-guard plumbing and the operations — including the Tauri command
//! adapters registered in `lib.rs`.

pub mod model;
pub(crate) mod consts;
pub(crate) mod service;

#[cfg(test)]
mod tests;

