//! SSH domain data structures, split by concern:
//!
//! - [`model`]: connection profiles, authentication and host-key trust.
//! - [`session_model`]: shell sessions, command execution and PTY traffic.

pub(crate) mod model;
pub(crate) mod session_model;

pub use model::*;
pub use session_model::*;
