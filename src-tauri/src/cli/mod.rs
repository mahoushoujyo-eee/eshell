//! The standalone entry points: `eshell-cli` and `eshell-mcp`.
//!
//! Both run eShell's server operations without the desktop app. The desktop
//! app owns a window and a set of terminal tabs; these two binaries own a
//! data directory and a set of SSH connections they open themselves, so an
//! agent can drive a server from a shell, from an MCP client, or from a
//! scheduled job.
//!
//! They share the MCP core with the app's own loopback bridge
//! ([`crate::domain::agent::service::mcp_server`]), so the tool surface is
//! identical — only the way a session target is interpreted differs.

pub(crate) mod args;
pub(crate) mod commands;
pub(crate) mod data_dir;
pub(crate) mod hostkey;
pub(crate) mod mcp_stdio;
pub(crate) mod runtime;

use std::process::ExitCode;

use clap::Parser;

use args::{Cli, McpArgs};
use hostkey::HostKeyPolicy;
use runtime::StandaloneRuntime;

/// Runs the `eshell-cli` command line.
pub fn run_cli() -> ExitCode {
    let cli = Cli::parse();
    let policy = HostKeyPolicy::from_strict_flag(cli.strict_host_key);
    let data_dir = data_dir::resolve(cli.data_dir.as_deref());

    let runtime = match StandaloneRuntime::new(data_dir, policy) {
        Ok(runtime) => std::sync::Arc::new(runtime),
        Err(error) => {
            eprintln!("eshell-cli: cannot open the data directory: {error}");
            return ExitCode::from(commands::EXIT_INTERNAL);
        }
    };

    let tokio_runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("eshell-cli: cannot start the async runtime: {error}");
            return ExitCode::from(commands::EXIT_INTERNAL);
        }
    };

    tokio_runtime.block_on(commands::dispatch(&cli, runtime))
}

/// Runs the `eshell-mcp` server.
pub fn run_mcp() -> ExitCode {
    let args = McpArgs::parse();
    let policy = HostKeyPolicy::from_strict_flag(args.strict_host_key);
    let data_dir = data_dir::resolve(args.data_dir.as_deref());

    let runtime = match StandaloneRuntime::new(data_dir, policy) {
        Ok(runtime) => std::sync::Arc::new(runtime),
        Err(error) => {
            eprintln!("eshell-mcp: cannot open the data directory: {error}");
            return ExitCode::from(commands::EXIT_INTERNAL);
        }
    };

    let tokio_runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("eshell-mcp: cannot start the async runtime: {error}");
            return ExitCode::from(commands::EXIT_INTERNAL);
        }
    };

    tokio_runtime.block_on(async move {
        let server = mcp_stdio::server_for(std::sync::Arc::clone(&runtime));
        match args.http {
            Some(port) => serve_http(server, port, args.token).await,
            None => mcp_stdio::serve(server).await,
        }
    })
}

/// Serves the MCP endpoint over loopback HTTP.
///
/// The same transport the desktop app uses, with the same bearer-token
/// contract — but here the server can open connections on demand.
async fn serve_http(
    server: crate::domain::agent::service::mcp_server::McpServer,
    port: u16,
    token: Option<String>,
) -> ExitCode {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("eshell-mcp: cannot bind 127.0.0.1:{port}: {error}");
            return ExitCode::from(commands::EXIT_INTERNAL);
        }
    };
    let bound_port = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(port);
    let token = token.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());

    eprintln!("eshell-mcp: listening on http://127.0.0.1:{bound_port}/mcp");
    eprintln!("eshell-mcp: bearer token {token}");

    crate::domain::agent::service::mcp_bridge::serve(listener, server, token).await;
    ExitCode::SUCCESS
}
