//! The `eshell-cli` subcommands.
//!
//! Every server operation goes through the same tool implementation the MCP
//! server uses (`mcp_server::execute_command_tool` and the SFTP / status
//! handlers), so the command line and an agent calling the tools report the
//! same stdout, stderr and exit code for the same session.

use std::io::Read;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::domain::agent::service::mcp_server;
use crate::domain::monitor::service as status;
use crate::domain::sftp::service as sftp;

use super::args::{Cli, Command};
use super::runtime::StandaloneRuntime;

/// The exit code used when eShell itself failed.
///
/// OpenSSH reserves 255 for its own errors, so a caller can tell them apart
/// from the remote command's exit code.
pub(crate) const EXIT_INTERNAL: u8 = 255;

/// The exit code used for a usage error, matching clap's own.
pub(crate) const EXIT_USAGE: u8 = 2;

/// Runs one subcommand.
pub(crate) async fn dispatch(cli: &Cli, runtime: Arc<StandaloneRuntime>) -> ExitCode {
    match &cli.command {
        Command::Profiles => print_profiles(cli, &runtime),
        Command::Config => print_config(cli, &runtime),
        Command::Exec { target, command } => exec(cli, &runtime, target, command).await,
        Command::Status { target } => server_status(cli, &runtime, target).await,
        Command::Ls { target, path } => list_dir(cli, &runtime, target, path).await,
        Command::Cat { target, path } => read_file(cli, &runtime, target, path).await,
        Command::Write {
            target,
            path,
            content,
            file,
        } => write_file(cli, &runtime, target, path, content.as_deref(), file.as_deref()).await,
        Command::Mcp => super::mcp_stdio::serve(super::mcp_stdio::server_for(runtime)).await,
    }
}

/// Lists the configured SSH profiles.
fn print_profiles(cli: &Cli, runtime: &StandaloneRuntime) -> ExitCode {
    let profiles = runtime.profiles();
    if cli.json {
        let list: Vec<Value> = profiles
            .iter()
            .map(|config| {
                json!({
                    "id": config.id,
                    "name": config.name,
                    "host": config.host,
                    "port": config.port,
                    "username": config.username,
                    "jumpHostId": config.jump_host_id,
                })
            })
            .collect();
        print_json(&json!({ "profiles": list }));
        return ExitCode::SUCCESS;
    }

    if profiles.is_empty() {
        println!("No SSH profiles configured.");
        println!(
            "Config directory: {}",
            runtime.state().storage.data_dir().display()
        );
        return ExitCode::SUCCESS;
    }

    let width = profiles
        .iter()
        .map(|config| config.name.chars().count())
        .max()
        .unwrap_or(4)
        .max(4);
    println!(
        "{:<width$}  {:<24}  {:<16}  {}",
        "NAME", "HOST:PORT", "USER", "ID"
    );
    for config in &profiles {
        println!(
            "{:<width$}  {:<24}  {:<16}  {}",
            config.name,
            format!("{}:{}", config.host, config.port),
            config.username,
            config.id
        );
    }
    ExitCode::SUCCESS
}

/// Shows where the configuration is read from.
fn print_config(cli: &Cli, runtime: &StandaloneRuntime) -> ExitCode {
    let data_dir = runtime.state().storage.data_dir();
    if cli.json {
        print_json(&json!({
            "dataDir": data_dir.to_string_lossy(),
            "profiles": runtime.profiles().len(),
        }));
        return ExitCode::SUCCESS;
    }
    println!("Data directory: {}", data_dir.display());
    println!("SSH profiles:   {}", runtime.profiles().len());
    ExitCode::SUCCESS
}

/// Runs a command on a server.
async fn exec(
    cli: &Cli,
    runtime: &StandaloneRuntime,
    target: &str,
    command: &[String],
) -> ExitCode {
    let command_line = command.join(" ");
    if command_line.trim().is_empty() {
        eprintln!("eshell-cli: exec needs a command to run");
        return ExitCode::from(EXIT_USAGE);
    }

    let session_id = match runtime.resolve_target(target).await {
        Ok(session_id) => session_id,
        Err(message) => return fail(&message),
    };
    let args = json!({ "sessionId": session_id, "command": command_line });
    let result = match mcp_server::execute_command_tool(&runtime.state(), &args).await {
        Ok(result) => result,
        Err(message) => return fail(&message),
    };

    if cli.json {
        print_json(&result);
    } else {
        let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or_default();
        let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or_default();
        print!("{stdout}");
        if !stderr.is_empty() {
            eprint!("{stderr}");
        }
    }

    let exit_code = result.get("exitCode").and_then(Value::as_i64).unwrap_or(0);
    ExitCode::from(exit_code.clamp(0, i64::from(EXIT_INTERNAL) - 1) as u8)
}

/// Fetches the live server metrics.
async fn server_status(cli: &Cli, runtime: &StandaloneRuntime, target: &str) -> ExitCode {
    let session_id = match runtime.resolve_target(target).await {
        Ok(session_id) => session_id,
        Err(message) => return fail(&message),
    };
    let args = json!({ "sessionId": session_id });
    let value = match status::mcp_get_server_status(&runtime.state(), args).await {
        Ok(value) => value,
        Err(message) => return fail(&message),
    };

    if cli.json {
        print_json(&value);
        return ExitCode::SUCCESS;
    }

    let cpu = value
        .get("cpu")
        .map(|cpu| format!("{cpu}"))
        .unwrap_or_else(|| "-".to_string());
    let memory = value
        .get("memory")
        .map(|memory| format!("{memory}"))
        .unwrap_or_else(|| "-".to_string());
    println!("CPU:    {cpu}");
    println!("Memory: {memory}");
    if let Some(disks) = value.get("disks").and_then(Value::as_array) {
        for disk in disks {
            println!(
                "Disk {}: {}",
                disk.get("mount").and_then(Value::as_str).unwrap_or("-"),
                disk.get("usage").and_then(Value::as_str).unwrap_or("-")
            );
        }
    }
    ExitCode::SUCCESS
}

/// Lists a remote directory.
async fn list_dir(
    cli: &Cli,
    runtime: &StandaloneRuntime,
    target: &str,
    path: &str,
) -> ExitCode {
    let session_id = match runtime.resolve_target(target).await {
        Ok(session_id) => session_id,
        Err(message) => return fail(&message),
    };
    let args = json!({ "sessionId": session_id, "path": path });
    let value = match sftp::mcp_list_remote_dir(&runtime.state(), args).await {
        Ok(value) => value,
        Err(message) => return fail(&message),
    };

    if cli.json {
        print_json(&value);
        return ExitCode::SUCCESS;
    }

    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        println!("(empty)");
        return ExitCode::SUCCESS;
    }
    for entry in entries {
        println!(
            "{:<12}  {:>12}  {}",
            entry.get("entryType").and_then(Value::as_str).unwrap_or("-"),
            entry.get("size").and_then(Value::as_u64).unwrap_or(0),
            entry.get("name").and_then(Value::as_str).unwrap_or("-")
        );
    }
    ExitCode::SUCCESS
}

/// Reads a remote file.
async fn read_file(
    cli: &Cli,
    runtime: &StandaloneRuntime,
    target: &str,
    path: &str,
) -> ExitCode {
    let session_id = match runtime.resolve_target(target).await {
        Ok(session_id) => session_id,
        Err(message) => return fail(&message),
    };
    let args = json!({ "sessionId": session_id, "path": path });
    let value = match sftp::mcp_read_remote_file(&runtime.state(), args).await {
        Ok(value) => value,
        Err(message) => return fail(&message),
    };

    if cli.json {
        print_json(&value);
        return ExitCode::SUCCESS;
    }
    let content = value.get("content").and_then(Value::as_str).unwrap_or_default();
    print!("{content}");
    ExitCode::SUCCESS
}

/// Writes a remote file.
async fn write_file(
    cli: &Cli,
    runtime: &StandaloneRuntime,
    target: &str,
    path: &str,
    content: Option<&str>,
    file: Option<&std::path::Path>,
) -> ExitCode {
    let content = match read_content(content, file).await {
        Ok(content) => content,
        Err(message) => return fail(&message),
    };

    let session_id = match runtime.resolve_target(target).await {
        Ok(session_id) => session_id,
        Err(message) => return fail(&message),
    };
    let args = json!({ "sessionId": session_id, "path": path, "content": content });
    let value = match sftp::mcp_write_remote_file(&runtime.state(), args).await {
        Ok(value) => value,
        Err(message) => return fail(&message),
    };

    if cli.json {
        print_json(&value);
    } else {
        let written = value.get("written").and_then(Value::as_str).unwrap_or(path);
        println!("Wrote {written}");
    }
    ExitCode::SUCCESS
}

/// Reads the content to write from the flag, a local file, or standard input.
async fn read_content(
    content: Option<&str>,
    file: Option<&std::path::Path>,
) -> Result<String, String> {
    if let Some(content) = content {
        return Ok(content.to_string());
    }
    if let Some(path) = file {
        let path = path.to_path_buf();
        let display = path.display().to_string();
        let label = display.clone();
        return tokio::task::spawn_blocking(move || {
            std::fs::read_to_string(&path).map_err(|error| format!("read {label}: {error}"))
        })
        .await
        .unwrap_or_else(|error| Err(format!("read {display}: {error}")));
    }
    tokio::task::spawn_blocking(|| {
        let mut buffer = String::new();
        std::io::stdin()
            .read_to_string(&mut buffer)
            .map_err(|error| format!("read stdin: {error}"))?;
        Ok(buffer)
    })
    .await
    .unwrap_or_else(|error| Err(format!("read stdin: {error}")))
}

/// Prints a JSON value.
fn print_json(value: &Value) {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    println!("{text}");
}

/// Reports a failure and returns the internal exit code.
fn fail(message: &str) -> ExitCode {
    eprintln!("eshell-cli: {message}");
    ExitCode::from(EXIT_INTERNAL)
}
