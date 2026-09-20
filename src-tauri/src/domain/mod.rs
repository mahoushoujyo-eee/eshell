//! Domain layer: one submodule per business area, each split into
//! `model.rs` (data structures), `service.rs` (business logic) and
//! `command.rs` (the Tauri command surface).
//!
//! Models are plain serializable structs with no behaviour; services own the
//! runtime state and the rules; commands adapt that surface to Tauri.

pub mod agent;
pub mod app_update;
pub mod config;
pub mod extensions;
pub mod monitor;
pub mod scripts;
pub mod sftp;
pub mod ssh;
