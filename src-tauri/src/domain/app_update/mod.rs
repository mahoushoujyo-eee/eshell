//! App-update domain: the Settings → Version tab's release lookup.

pub mod command;
pub(crate) mod consts;
pub(crate) mod model;
pub(crate) mod service;

#[cfg(test)]
mod tests;

pub use model::{ReleaseAsset, ReleaseCheck};
