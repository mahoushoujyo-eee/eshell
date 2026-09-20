//! Server-monitor domain: metric probes and the per-tab status cache.
//!
//! `model.rs` holds the wire structs; `service/` owns the probes, the poll
//! pipeline and the status cache — including the Tauri command adapters.

pub(crate) mod consts;
pub mod model;
pub(crate) mod service;

#[cfg(test)]
mod tests;
