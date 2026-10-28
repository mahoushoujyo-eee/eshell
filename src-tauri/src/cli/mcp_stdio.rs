//! The stdio MCP transport.
//!
//! MCP over stdio is newline-delimited JSON-RPC: one JSON object per line on
//! standard output, and nothing else — every log line goes to standard error,
//! because a stray byte on stdout would corrupt the protocol stream.
//!
//! Each request is handled on its own task, so a long-running tool call
//! cannot block the ones behind it. Responses carry their request id, so
//! out-of-order replies are fine. When standard input reaches EOF the server
//! waits for the requests still in flight before exiting, so a client that
//! pipes its requests and closes the pipe still receives every answer.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::domain::agent::service::mcp_server::McpServer;

use super::runtime::{StandaloneRuntime, StandaloneSessionResolver};

/// Builds the standalone server for a runtime.
pub(crate) fn server_for(runtime: Arc<StandaloneRuntime>) -> McpServer {
    let state = runtime.state();
    let resolver = Arc::new(StandaloneSessionResolver::new(Arc::clone(&runtime)));
    McpServer::standalone(state, resolver)
}

/// Serves MCP over stdio until standard input closes.
pub(crate) async fn serve(server: McpServer) -> std::process::ExitCode {
    let server = Arc::new(server);
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    // One writer, so two responses can never interleave on stdout.
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                eprintln!("eshell-mcp: cannot read standard input: {error}");
                drain(tasks).await;
                return std::process::ExitCode::from(super::commands::EXIT_INTERNAL);
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(trimmed) {
            Ok(message) => message,
            Err(error) => {
                // A malformed line has no id, so there is nothing to answer.
                eprintln!("eshell-mcp: ignoring a malformed JSON line: {error}");
                continue;
            }
        };

        // A message without an id is a notification: it is executed, but it
        // is never answered.
        let has_id = message.get("id").is_some();
        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
        let task_server = Arc::clone(&server);
        let task_stdout = Arc::clone(&stdout);
        let task = tokio::spawn(async move {
            let response = task_server.handle(&message).await;
            if !has_id {
                return;
            }
            if let Err(error) = write_response(&task_stdout, request_id, response).await {
                eprintln!("eshell-mcp: cannot write to standard output: {error}");
            }
        });
        tasks.push(task);
        tasks.retain(|task| !task.is_finished());
    }

    // Standard input is closed, but a request may still be running. Wait for
    // it, so its response is not lost.
    drain(tasks).await;
    std::process::ExitCode::SUCCESS
}

/// Waits for the requests still in flight.
async fn drain(tasks: Vec<tokio::task::JoinHandle<()>>) {
    for task in tasks {
        if let Err(error) = task.await {
            eprintln!("eshell-mcp: a tool call panicked: {error}");
        }
    }
}

/// Writes one JSON-RPC response and a newline, then flushes.
async fn write_response(
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    request_id: Value,
    response: Value,
) -> std::io::Result<()> {
    // A panicked handler must still produce a reply, or the client waits
    // forever for an answer that never comes.
    let response = if response.get("result").is_some() || response.get("error").is_some() {
        response
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32603, "message": "internal error"}
        })
    };
    let payload = match serde_json::to_string(&response) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("eshell-mcp: cannot serialize a response: {error}");
            return Ok(());
        }
    };

    let mut stdout = stdout.lock().await;
    stdout.write_all(payload.as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await
}
