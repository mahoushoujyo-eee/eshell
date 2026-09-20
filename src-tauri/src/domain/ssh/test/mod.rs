//! Test-only code for the SSH domain.
//!
//! Everything here is compiled under `cargo test` only — `ssh/mod.rs` declares
//! this module behind `#[cfg(test)]`.
//!
//! - `test_support.rs` — the in-process russh server the transport and state
//!   tests connect to, plus the throwaway key and credentials it accepts.
//! - `integration_tests.rs` — loopback regressions that drive a real socket.
//! - `*_tests.rs` — the unit tests for the matching business file, one module
//!   per source file.

pub(crate) mod test_support;

mod error_tests;
mod integration_tests;
mod pty_tests;
mod session_tests;
mod transport_tests;
