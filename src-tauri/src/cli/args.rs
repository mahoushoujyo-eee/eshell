//! Command-line arguments for the two standalone binaries.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// `eshell-cli` — eShell server operations from the command line.
#[derive(Debug, Parser)]
#[command(
    name = "eshell-cli",
    version,
    about = "Run eShell server operations from the command line",
    long_about = None
)]
pub(crate) struct Cli {
    /// Directory holding eShell's `.eshell-data` files.
    #[arg(long, global = true, value_name = "DIR")]
    pub(crate) data_dir: Option<PathBuf>,

    /// Refuse unknown and changed SSH host keys instead of trusting them.
    #[arg(long, global = true)]
    pub(crate) strict_host_key: bool,

    /// Print machine-readable JSON instead of human-readable text.
    #[arg(long, global = true)]
    pub(crate) json: bool,

    #[command(subcommand)]
    pub(crate) command: Command,
}

/// The `eshell-cli` subcommands.
#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// List the configured SSH server profiles.
    Profiles,

    /// Show where eShell's configuration is read from.
    Config,

    /// Run a command on a server.
    Exec {
        /// SSH profile name or id.
        target: String,
        /// The command to run.
        #[arg(num_args = 1.., trailing_var_arg = true, required = true)]
        command: Vec<String>,
    },

    /// Fetch live CPU, memory, disk, network and process metrics.
    Status {
        /// SSH profile name or id.
        target: String,
    },

    /// List a remote directory.
    Ls {
        /// SSH profile name or id.
        target: String,
        /// Absolute remote directory path.
        path: String,
    },

    /// Read a remote file.
    Cat {
        /// SSH profile name or id.
        target: String,
        /// Absolute remote file path.
        path: String,
    },

    /// Write a remote file.
    Write {
        /// SSH profile name or id.
        target: String,
        /// Absolute remote file path.
        path: String,
        /// The file content. Standard input is read when neither this nor
        /// `--file` is given.
        #[arg(long, value_name = "TEXT")]
        content: Option<String>,
        /// Read the content from a local file.
        #[arg(long, short, value_name = "PATH")]
        file: Option<PathBuf>,
    },

    /// Run the MCP server on stdio.
    Mcp,
}

/// `eshell-mcp` — the standalone MCP server.
#[derive(Debug, Parser)]
#[command(
    name = "eshell-mcp",
    version,
    about = "eShell MCP server: the same tools the desktop app exposes, over stdio",
    long_about = None
)]
pub(crate) struct McpArgs {
    /// Directory holding eShell's `.eshell-data` files.
    #[arg(long, value_name = "DIR")]
    pub(crate) data_dir: Option<PathBuf>,

    /// Refuse unknown and changed SSH host keys instead of trusting them.
    #[arg(long)]
    pub(crate) strict_host_key: bool,

    /// Serve over streamable HTTP on this port instead of stdio.
    #[arg(long, value_name = "PORT")]
    pub(crate) http: Option<u16>,

    /// The bearer token the HTTP endpoint requires. A random one is generated
    /// when this is omitted.
    #[arg(long, value_name = "TOKEN")]
    pub(crate) token: Option<String>,
}
