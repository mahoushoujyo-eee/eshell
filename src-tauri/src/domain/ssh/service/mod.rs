//! SSH service layer: transport, PTY workers and session command execution.

pub(crate) mod error;
pub(crate) mod handler;
pub(crate) mod channel;
pub mod pty;
pub(crate) mod session;
pub mod transport;

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod integration_tests;

pub use session::{
    close_shell_session, execute_command, open_shell_session, pty_resize, pty_write_input,
    reopen_shell_pty, ssh_ki_respond,
};
