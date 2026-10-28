//! The `eshell-cli` command line: eShell server operations without the
//! desktop app.
//!
//! ```text
//! eshell-cli profiles
//! eshell-cli exec prod -- "docker ps"
//! eshell-cli status prod
//! eshell-cli cat prod /etc/hosts
//! ```

use std::process::ExitCode;

fn main() -> ExitCode {
    eshell_codex_lib::cli::run_cli()
}
