//! Agent domain data structures, split by concern:
//!
//! - [`agent`]: spawn configuration, the runner registry and `acp_agents.json`.
//! - [`session`]: the wire inputs the `acp_*` commands decode.
//! - [`view`]: the `Serialize`-only shapes the frontend panel consumes.
//! - [`history`]: persisted session transcripts under `acp_sessions/`.
//! - [`project`]: the local project registry rows.

pub(crate) mod agent;
pub(crate) mod history;
pub(crate) mod project;
pub(crate) mod session;
pub(crate) mod view;

pub use agent::*;
pub use history::*;
pub use project::*;
pub use session::*;
pub use view::*;
