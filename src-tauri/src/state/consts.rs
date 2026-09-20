//! Constants for the application-state container.
//!
//! Currently empty by design: every tuning constant the container's
//! collaborators need lives next to the domain that owns it (see
//! `domain/ssh/consts.rs`, `domain/sftp/consts.rs`, `mcp_bridge/consts.rs`).
//! Add a constant here only when it is genuinely container-level — a lock
//! ordering rule or a shared size limit — rather than one domain's setting.
