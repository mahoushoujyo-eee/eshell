//! Local MCP (Model Context Protocol) bridge.
//!
//! Exposes eShell's SSH profiles, active shell sessions, remote command
//! execution, SFTP file access, and server status as MCP tools over a
//! loopback streamable-HTTP endpoint. ACP agent sessions get this endpoint
//! injected automatically (see `acp_agent_start`), so external coding agents
//! can operate the servers the user already manages in eShell; destructive
//! tool calls still flow through the agent's own permission prompts, which
//! the ACP panel surfaces as approval cards.
//!
//! Transport: MCP streamable HTTP with a single JSON response per POST (no
//! SSE stream, which the spec permits). Bound to 127.0.0.1 with a per-run
//! bearer token so other local processes cannot call it.

use std::sync::Arc;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::AUTHORIZATION;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

use crate::models::{FetchServerStatusInput, SftpListInput, SftpReadInput, SftpWriteInput};
use crate::server_ops;
use crate::state::{AppState, McpBridgeInfo};

const MCP_PATH: &str = "/mcp";
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Tool output is embedded in the agent's context; keep it bounded.
const MAX_TOOL_TEXT_CHARS: usize = 60_000;
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const FALLBACK_PROTOCOL_VERSION: &str = "2025-03-26";

/// Binds the loopback listener, registers the endpoint in app state, and
/// serves connections for the lifetime of the app.
pub async fn start(state: Arc<AppState>) -> Result<McpBridgeInfo, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bind mcp bridge: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("mcp bridge local addr: {e}"))?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let info = McpBridgeInfo {
        port,
        token: token.clone(),
    };
    state.set_mcp_bridge(info.clone());

    tokio::spawn(serve(listener, state, token));
    Ok(info)
}

async fn serve(listener: tokio::net::TcpListener, state: Arc<AppState>, token: String) {
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => continue,
        };
        let io = TokioIo::new(stream);
        let state = Arc::clone(&state);
        let token = token.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request: Request<Incoming>| {
                let state = Arc::clone(&state);
                let token = token.clone();
                async move {
                    Ok::<_, std::convert::Infallible>(handle_http(request, state, &token).await)
                }
            });
            let _ = http1::Builder::new().serve_connection(io, service).await;
        });
    }
}

async fn handle_http(
    request: Request<Incoming>,
    state: Arc<AppState>,
    token: &str,
) -> Response<Full<Bytes>> {
    if request.uri().path() != MCP_PATH {
        return plain_response(StatusCode::NOT_FOUND, "not found");
    }
    if request.method() != Method::POST {
        return plain_response(StatusCode::METHOD_NOT_ALLOWED, "POST only");
    }

    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == format!("Bearer {token}"))
        .unwrap_or(false);
    if !authorized {
        return plain_response(StatusCode::UNAUTHORIZED, "missing or invalid bearer token");
    }

    let body = match Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(_) => return plain_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large"),
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return plain_response(StatusCode::BAD_REQUEST, "invalid JSON");
    };

    // Notifications (no id) get acknowledged without a body, per streamable HTTP.
    if message.get("id").is_none() {
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Full::new(Bytes::new()))
            .unwrap();
    }

    // Tool calls await SSH/SFTP work directly on the connection task.
    let response = handle_rpc(&state, &message).await;

    let payload = serde_json::to_vec(&response).unwrap_or_default();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(payload)))
        .unwrap()
}

fn plain_response(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(Full::new(Bytes::from(message.to_string())))
        .unwrap()
}

/// Dispatches one JSON-RPC request, awaiting the async server_ops layer directly.
pub(crate) async fn handle_rpc(state: &Arc<AppState>, message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

    let result = match method {
        "initialize" => Ok(initialize_result(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(state, &params).await,
        // eShell serves tools only, but a client probing the other primitive
        // families must get a spec-shaped empty list rather than a method-not-
        // found error — agents otherwise report the whole bridge as missing.
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "resources/read" => Err((
            -32602,
            "eShell exposes MCP tools only; it has no resources to read".to_string(),
        )),
        "prompts/get" => Err((
            -32602,
            "eShell exposes MCP tools only; it has no prompts to serve".to_string(),
        )),
        other => Err((-32601, format!("method not found: {other}"))),
    };

    match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message}
        }),
    }
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(FALLBACK_PROTOCOL_VERSION);
    let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        FALLBACK_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "eshell",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "This server exposes MCP tools only — it has no resources and \
            no prompts, so empty resource/prompt lists are expected, not a failure. \
            Tools for the servers the user manages in eShell: call read_agent_context \
            once at session start (it returns the user's AGENTS.md instructions and the \
            bundled eshell-config skill), and list_shell_sessions before any server work — \
            commands and file access run inside an existing session opened by the user \
            (identified by sessionId) and execute on that remote server, in the session's \
            current directory.",
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    })
}

fn session_id_property() -> Value {
    json!({
        "type": "string",
        "description": "Shell session id from list_shell_sessions",
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "read_agent_context",
            "Read the user's agent context from eShell: the global AGENTS.md instructions \
             users write for agents, plus the bundled eshell-config skill that documents \
             eShell's config files and server-operation rules. Call this once at the \
             start of a session before doing any work.",
            json!({}),
            &[],
        ),
        tool(
            "list_ssh_profiles",
            "List the SSH server profiles configured in eShell (no credentials).",
            json!({}),
            &[],
        ),
        tool(
            "list_shell_sessions",
            "List the currently open eShell terminal sessions. Returns each session's id, \
             server profile, and current working directory. Other tools operate on these sessions.",
            json!({}),
            &[],
        ),
        tool(
            "execute_command",
            "Run a non-interactive shell command on the remote server of an open session, \
             in that session's current working directory. Returns stdout, stderr, and exit code. \
             `cd` updates the session's working directory.",
            json!({
                "sessionId": session_id_property(),
                "command": {"type": "string", "description": "Shell command to execute"},
            }),
            &["sessionId", "command"],
        ),
        tool(
            "read_remote_file",
            "Read a text file from the remote server of an open session via SFTP.",
            json!({
                "sessionId": session_id_property(),
                "path": {"type": "string", "description": "Absolute remote path"},
            }),
            &["sessionId", "path"],
        ),
        tool(
            "write_remote_file",
            "Write (create or overwrite) a text file on the remote server of an open session via SFTP.",
            json!({
                "sessionId": session_id_property(),
                "path": {"type": "string", "description": "Absolute remote path"},
                "content": {"type": "string", "description": "Full file content to write"},
            }),
            &["sessionId", "path", "content"],
        ),
        tool(
            "list_remote_dir",
            "List a directory on the remote server of an open session via SFTP.",
            json!({
                "sessionId": session_id_property(),
                "path": {"type": "string", "description": "Absolute remote directory path"},
            }),
            &["sessionId", "path"],
        ),
        tool(
            "get_server_status",
            "Fetch live CPU, memory, disk, network, and top-process metrics for the remote \
             server of an open session.",
            json!({ "sessionId": session_id_property() }),
            &["sessionId"],
        ),
    ]
}

async fn call_tool(state: &Arc<AppState>, params: &Value) -> Result<Value, (i32, String)> {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err((-32602, "tools/call requires params.name".to_string()));
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let outcome: Result<Value, String> = match name {
        "read_agent_context" => read_agent_context(state),
        "list_ssh_profiles" => Ok(list_ssh_profiles(state)),
        "list_shell_sessions" => Ok(list_shell_sessions(state)),
        "execute_command" => execute_command(state, &args).await,
        "read_remote_file" => read_remote_file(state, &args).await,
        "write_remote_file" => write_remote_file(state, &args).await,
        "list_remote_dir" => list_remote_dir(state, &args).await,
        "get_server_status" => get_server_status(state, &args).await,
        other => return Err((-32602, format!("unknown tool `{other}`"))),
    };

    // Tool-level failures are reported inside the result (isError), not as
    // protocol errors, so the agent can read and react to them.
    Ok(match outcome {
        Ok(value) => json!({
            "content": [{"type": "text", "text": to_bounded_text(&value)}],
            "isError": false,
        }),
        Err(message) => json!({
            "content": [{"type": "text", "text": message}],
            "isError": true,
        }),
    })
}

fn to_bounded_text(value: &Value) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    if text.chars().count() <= MAX_TOOL_TEXT_CHARS {
        return text;
    }
    let truncated: String = text.chars().take(MAX_TOOL_TEXT_CHARS).collect();
    format!(
        "{truncated}\n…[truncated {} chars]",
        text.chars().count() - MAX_TOOL_TEXT_CHARS
    )
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing or empty argument `{key}`"))
}

/// Serves the agent-context tool: the global AGENTS.md plus the bundled
/// eshell-config skill, so agents pick up the user's instructions without
/// the app injecting them into prompts.
fn read_agent_context(state: &Arc<AppState>) -> Result<Value, String> {
    let global = state
        .storage
        .get_agent_context(None)
        .map_err(|e| e.to_string())?;
    let skill_path = state
        .storage
        .data_dir()
        .join("agent")
        .join("skills")
        .join("eshell-config")
        .join("SKILL.md");
    let skill = std::fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    Ok(json!({
        "agentsMd": {
            "path": global.path,
            "exists": global.exists,
            "content": global.content,
        },
        "eshellConfigSkill": {
            "path": skill_path.to_string_lossy(),
            "content": skill,
        },
    }))
}

fn list_ssh_profiles(state: &Arc<AppState>) -> Value {
    let profiles: Vec<Value> = state
        .storage
        .list_ssh_configs()
        .into_iter()
        .map(|config| {
            json!({
                "id": config.id,
                "name": config.name,
                "host": config.host,
                "port": config.port,
                "username": config.username,
            })
        })
        .collect();
    json!({ "profiles": profiles })
}

fn list_shell_sessions(state: &Arc<AppState>) -> Value {
    let sessions: Vec<Value> = state
        .list_sessions()
        .into_iter()
        .map(|session| {
            json!({
                "sessionId": session.id,
                "profile": session.config_name,
                "configId": session.config_id,
                "currentDir": session.current_dir,
                "updatedAt": session.updated_at,
            })
        })
        .collect();
    json!({ "sessions": sessions })
}

async fn execute_command(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let session_id = arg_str(args, "sessionId")?;
    let command = arg_str(args, "command")?;
    let result = server_ops::execute_command(state, &session_id, &command)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
        "currentDir": result.current_dir,
        "durationMs": result.duration_ms,
    }))
}

// The bridge has no AppHandle and only ever touches sessions the user already
// opened, so `server_ops` calls pass `None` for the app handle: that parameter
// exists to emit keyboard-interactive 2FA prompts while (re)connecting, and a
// headless HTTP tool call has no UI to prompt through — it fails with an error
// instead, which is the right outcome for an agent-triggered call.
async fn read_remote_file(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let input = SftpReadInput {
        session_id: arg_str(args, "sessionId")?,
        path: arg_str(args, "path")?,
    };
    let file = server_ops::sftp_read_file(state, None, input)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(file).map_err(|e| e.to_string())
}

async fn write_remote_file(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let input = SftpWriteInput {
        session_id: arg_str(args, "sessionId")?,
        path: arg_str(args, "path")?,
        content: args
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("missing argument `content`")?,
    };
    let path = input.path.clone();
    server_ops::sftp_write_file(state, None, input)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "written": path }))
}

async fn list_remote_dir(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let input = SftpListInput {
        session_id: arg_str(args, "sessionId")?,
        path: arg_str(args, "path")?,
    };
    let listing = server_ops::sftp_list_dir(state, None, input)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(listing).map_err(|e| e.to_string())
}

async fn get_server_status(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let input = FetchServerStatusInput {
        session_id: arg_str(args, "sessionId")?,
        selected_interface: None,
    };
    let status = server_ops::fetch_server_status(state, None, input)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> Arc<AppState> {
        let dir = std::env::temp_dir().join(format!(
            "eshell-mcp-bridge-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Arc::new(AppState::new(dir).expect("create test state"))
    }

    fn rpc(method: &str, params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    }

    #[tokio::test]
    async fn initialize_echoes_supported_version_and_falls_back() {
        let state = test_state();
        let response = handle_rpc(
            &state,
            &rpc("initialize", json!({"protocolVersion": "2025-06-18"})),
        )
        .await;
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(response["result"]["serverInfo"]["name"], "eshell");

        let response = handle_rpc(
            &state,
            &rpc("initialize", json!({"protocolVersion": "9999-01-01"})),
        )
        .await;
        assert_eq!(
            response["result"]["protocolVersion"],
            FALLBACK_PROTOCOL_VERSION
        );
    }

    #[tokio::test]
    async fn tools_list_exposes_the_session_tools() {
        let state = test_state();
        let response = handle_rpc(&state, &rpc("tools/list", json!({}))).await;
        let tools = response["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"read_agent_context"));
        assert!(names.contains(&"execute_command"));
        assert!(names.contains(&"list_shell_sessions"));
        assert!(names.contains(&"read_remote_file"));
        for tool in tools {
            assert!(tool["inputSchema"]["type"] == "object");
        }
    }

    #[tokio::test]
    async fn read_agent_context_returns_global_md_and_skill() {
        let state = test_state();
        state
            .storage
            .save_agent_context(None, "# my instructions")
            .expect("save context");

        let response = handle_rpc(
            &state,
            &rpc("tools/call", json!({"name": "read_agent_context", "arguments": {}})),
        )
        .await;
        assert_eq!(response["result"]["isError"], false);
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).expect("json payload");
        assert_eq!(payload["agentsMd"]["content"], "# my instructions");
        assert_eq!(payload["agentsMd"]["exists"], true);
        let skill = payload["eshellConfigSkill"]["content"].as_str().unwrap();
        assert!(skill.contains("eshell-config"));
    }

    #[tokio::test]
    async fn resource_and_prompt_probes_get_empty_lists_not_errors() {
        let state = test_state();
        for (method, key) in [
            ("resources/list", "resources"),
            ("resources/templates/list", "resourceTemplates"),
            ("prompts/list", "prompts"),
        ] {
            let response = handle_rpc(&state, &rpc(method, json!({}))).await;
            assert!(response.get("error").is_none(), "{method} must not error");
            assert_eq!(response["result"][key], json!([]), "{method}");
        }

        // Actually reading gets a clear "tools only" message rather than -32601.
        let response = handle_rpc(&state, &rpc("resources/read", json!({"uri": "x"}))).await;
        assert_eq!(response["error"]["code"], -32602);
        assert!(response["error"]["message"].as_str().unwrap().contains("tools only"));
    }

    #[tokio::test]
    async fn unknown_method_and_unknown_tool_report_errors() {
        let state = test_state();
        let response = handle_rpc(&state, &rpc("bogus/method", json!({}))).await;
        assert_eq!(response["error"]["code"], -32601);

        let response = handle_rpc(
            &state,
            &rpc("tools/call", json!({"name": "bogus_tool", "arguments": {}})),
        )
        .await;
        assert_eq!(response["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn list_tools_work_on_empty_state_and_bad_session_errors_inside_result() {
        let state = test_state();
        let response = handle_rpc(
            &state,
            &rpc(
                "tools/call",
                json!({"name": "list_shell_sessions", "arguments": {}}),
            ),
        )
        .await;
        assert_eq!(response["result"]["isError"], false);

        let response = handle_rpc(
            &state,
            &rpc(
                "tools/call",
                json!({"name": "execute_command", "arguments": {"sessionId": "nope", "command": "ls"}}),
            ),
        )
        .await;
        assert_eq!(response["result"]["isError"], true);
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("nope"));
    }

    #[tokio::test]
    async fn http_endpoint_enforces_token_and_serves_initialize() {
        let state = test_state();
        let info = start(Arc::clone(&state)).await.expect("start bridge");
        assert!(state.mcp_bridge().is_some());
        let url = format!("http://127.0.0.1:{}/mcp", info.port);
        let client = reqwest::Client::new();

        let unauthorized = client
            .post(&url)
            .json(&rpc("ping", json!({})))
            .send()
            .await
            .expect("request");
        assert_eq!(unauthorized.status(), 401);

        let ok = client
            .post(&url)
            .bearer_auth(&info.token)
            .json(&rpc("initialize", json!({"protocolVersion": "2025-03-26"})))
            .send()
            .await
            .expect("request");
        assert_eq!(ok.status(), 200);
        let body: Value = ok.json().await.expect("json body");
        assert_eq!(body["result"]["serverInfo"]["name"], "eshell");
        assert_eq!(body["result"]["protocolVersion"], "2025-03-26");

        // Notifications are acknowledged without a body.
        let notification = client
            .post(&url)
            .bearer_auth(&info.token)
            .json(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .send()
            .await
            .expect("request");
        assert_eq!(notification.status(), 202);
    }
}
