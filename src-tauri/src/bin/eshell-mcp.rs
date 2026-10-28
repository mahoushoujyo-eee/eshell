//! The `eshell-mcp` standalone MCP server: the same tools the desktop app
//! exposes on its loopback bridge, served over stdio instead.
//!
//! ```text
//! eshell-mcp
//! eshell-mcp --data-dir D:/eshell-data --strict-host-key
//! eshell-mcp --http 8765
//! ```

use std::process::ExitCode;

fn main() -> ExitCode {
    eshell_codex_lib::cli::run_mcp()
}
