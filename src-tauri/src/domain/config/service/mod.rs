//! Config domain services.
//!
//! - [`storage`]: the `Storage` container and its bootstrap (file seeding,
//!   legacy migration).
//! - [`ssh_store`] / [`known_hosts_store`]: the per-collection CRUD impls on
//!   `Storage`.
//! - [`agent_context_store`]: the AGENTS.md file impls on `Storage`.
//! - [`reload`]: re-reading hand-edited config files into memory.
//! - [`io`]: the JSON read/write helpers every store shares.

pub(crate) mod agent_context_store;
pub(crate) mod io;
pub(crate) mod known_hosts_store;
pub(crate) mod reload;
pub(crate) mod ssh_store;
pub(crate) mod storage;
