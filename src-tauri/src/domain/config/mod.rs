//! Config domain: persistent JSON stores (SSH profiles, known hosts, agent
//! context) and the reload surface for hand-edited config files.

pub mod command;
pub(crate) mod consts;
pub(crate) mod model;
pub(crate) mod service;

#[cfg(test)]
mod tests;

pub use service::reload::{ConfigFile, ReloadOutcome};
pub use service::storage::Storage;
