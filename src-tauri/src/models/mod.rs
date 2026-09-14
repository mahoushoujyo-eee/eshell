//! Serializable types shared by the Tauri commands, storage and the frontend.
//!
//! Split by domain; everything is re-exported here so call sites keep using
//! `crate::models::Type` regardless of which file a type lives in.

mod ai;
mod ai_import;
mod common;
mod script;
mod sftp;
mod shell;
mod ssh;
mod status;

pub use ai::*;
pub use ai_import::*;
pub use common::*;
pub use script::*;
pub use sftp::*;
pub use shell::*;
pub use ssh::*;
pub use status::*;
