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
        "tools/list" => Ok(json!({ "tools": tool_definitions(state) })),
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

/// The tools the bridge itself owns: agent context, profiles, sessions and
/// command execution.
///
/// SFTP and server-status tools are contributed by their plugins through
/// [`plugin_tool_definitions`]: the definitions and the call handlers are
/// registered by the plugin, so deactivating a plugin removes its tools from
/// both `tools/list` and `tools/call` in one place. The concatenation order
/// below is the wire contract: core tools first, then the plugins in
/// manifest order, exactly as before the migration.
fn tool_definitions(state: &Arc<AppState>) -> Vec<Value> {
    let mut tools = vec![
        tool(
            "read_agent_context",
            "Read the user's agent context from eShell: the global AGENTS.md instructions \
             users write for agents, plus the bundled eshell-config skill (eShell's config \
             files and server-operation rules) and the eshell-plugin-dev skill (how to \
             write an eShell external plugin). Call this once at the start of a session \
             before doing any work.",
            json!({}),
            &[],
        ),
        tool(
            "reload_config",
            "Re-read eShell's config files after editing them outside the app, so the \
             change takes effect without restarting. Pass `file` for one file \
             (sshConfigs, acpAgents, scripts, aiProfiles, agentContext) or omit it to \
             reload all. Returns per-file outcomes: a missing file keeps the current \
             value, and a file that fails to parse is reported rather than applied. \
             Reloading does not restart anything — an open SSH session keeps its \
             connection, and a running agent keeps its spawn settings until restarted.",
            json!({
                "file": {
                    "type": "string",
                    "description": "One of sshConfigs, acpAgents, scripts, aiProfiles, agentContext. Omit to reload all.",
                },
            }),
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
    ];
    tools.extend(crate::plugins::mcp_tools::plugin_tool_definitions(state));
    tools
}

/// Dispatches a tool call to the plugin that registered it.
///
/// Returns `None` when no plugin owns `name` (an unknown tool), `Some`
/// otherwise. A deactivated plugin's tools are absent here too, so calling
/// one reports the same unknown-tool error as before it existed.
async fn call_plugin_tool(
    state: &Arc<AppState>,
    name: &str,
    args: &Value,
) -> Option<Result<Value, String>> {
    crate::plugins::mcp_tools::dispatch_plugin_tool(state, name, args).await
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
        "reload_config" => reload_config(state, &args),
        "list_ssh_profiles" => Ok(list_ssh_profiles(state)),
        "list_shell_sessions" => Ok(list_shell_sessions(state)),
        "execute_command" => execute_command(state, &args).await,
        other => match call_plugin_tool(state, other, &args).await {
            Some(outcome) => outcome,
            None => return Err((-32602, format!("unknown tool `{other}`"))),
        },
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

/// The bundled skills this tool serves, in the order they appear in the
/// response. Each is seeded into `.eshell-data/agent/skills/<dir>/SKILL.md`
/// at startup (see `storage::seed_agent_context`).
const BUNDLED_SKILLS: &[(&str, &str)] = &[
    ("eshell-config", "eshellConfigSkill"),
    ("eshell-plugin-dev", "eshellPluginDevSkill"),
];

/// Serves the agent-context tool: the global AGENTS.md plus the bundled
/// skills, so agents pick up the user's instructions without the app
/// injecting them into prompts.
fn read_agent_context(state: &Arc<AppState>) -> Result<Value, String> {
    let global = state
        .storage
        .get_agent_context(None)
        .map_err(|e| e.to_string())?;

    let mut payload = json!({
        "agentsMd": {
            "path": global.path,
            "exists": global.exists,
            "content": global.content,
        },
    });

    for (dir, key) in BUNDLED_SKILLS {
        let path = state
            .storage
            .data_dir()
            .join("agent")
            .join("skills")
            .join(dir)
            .join("SKILL.md");
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        payload[key] = json!({
            "path": path.to_string_lossy(),
            "content": content,
        });
    }

    Ok(payload)
}

/// Re-reads config files edited outside the app.
///
/// The agent edits `.eshell-data/*.json` directly (that is what the
/// eshell-config skill documents), so it needs a way to make the host pick
/// the edit up. Without this the only answer was "restart the app".
fn reload_config(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let outcomes = match args.get("file").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => {
            let file = crate::storage::ConfigFile::parse(name).map_err(|e| e.to_string())?;
            vec![state.storage.reload_config(file)]
        }
        _ => state.storage.reload_all_configs(),
    };
    serde_json::to_value(outcomes).map_err(|e| e.to_string())
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

    /// The pre-migration `tools/list`, captured from git HEAD. Do not
    /// regenerate from the current implementation.
    ///
    /// Two deliberate edits since capture. `read_agent_context`'s description
    /// now names both bundled skills, and `reload_config` was added after it
    /// so an agent can make an external config edit take effect. Both are
    /// additive: no captured tool changed its name, order or schema.
    const PRE_MIGRATION_TOOLS_LIST_JSON: &str = r#"[
  {
    "name": "read_agent_context",
    "description": "Read the user's agent context from eShell: the global AGENTS.md instructions users write for agents, plus the bundled eshell-config skill (eShell's config files and server-operation rules) and the eshell-plugin-dev skill (how to write an eShell external plugin). Call this once at the start of a session before doing any work.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "reload_config",
    "description": "Re-read eShell's config files after editing them outside the app, so the change takes effect without restarting. Pass `file` for one file (sshConfigs, acpAgents, scripts, aiProfiles, agentContext) or omit it to reload all. Returns per-file outcomes: a missing file keeps the current value, and a file that fails to parse is reported rather than applied. Reloading does not restart anything — an open SSH session keeps its connection, and a running agent keeps its spawn settings until restarted.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "file": {
          "type": "string",
          "description": "One of sshConfigs, acpAgents, scripts, aiProfiles, agentContext. Omit to reload all."
        }
      },
      "required": []
    }
  },
  {
    "name": "list_ssh_profiles",
    "description": "List the SSH server profiles configured in eShell (no credentials).",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "list_shell_sessions",
    "description": "List the currently open eShell terminal sessions. Returns each session's id, server profile, and current working directory. Other tools operate on these sessions.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "execute_command",
    "description": "Run a non-interactive shell command on the remote server of an open session, in that session's current working directory. Returns stdout, stderr, and exit code. `cd` updates the session's working directory.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "command": {
          "type": "string",
          "description": "Shell command to execute"
        }
      },
      "required": [
        "sessionId",
        "command"
      ]
    }
  },
  {
    "name": "read_remote_file",
    "description": "Read a text file from the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote path"
        }
      },
      "required": [
        "sessionId",
        "path"
      ]
    }
  },
  {
    "name": "write_remote_file",
    "description": "Write (create or overwrite) a text file on the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote path"
        },
        "content": {
          "type": "string",
          "description": "Full file content to write"
        }
      },
      "required": [
        "sessionId",
        "path",
        "content"
      ]
    }
  },
  {
    "name": "list_remote_dir",
    "description": "List a directory on the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote directory path"
        }
      },
      "required": [
        "sessionId",
        "path"
      ]
    }
  },
  {
    "name": "get_server_status",
    "description": "Fetch live CPU, memory, disk, network, and top-process metrics for the remote server of an open session.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        }
      },
      "required": [
        "sessionId"
      ]
    }
  }
]"#;

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
        let names: Vec<String> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"read_agent_context".to_string()));
        assert!(names.contains(&"execute_command".to_string()));
        assert!(names.contains(&"list_shell_sessions".to_string()));
        assert!(names.contains(&"read_remote_file".to_string()));
        for tool in tools {
            assert!(tool["inputSchema"]["type"] == "object");
        }
    }

    /// The complete default `tools/list` must equal the pre-migration list
    /// (git HEAD `tool_definitions()`): names, order, schemas, descriptions.
    /// The golden value below was captured from that implementation, not
    /// regenerated from this one.
    #[tokio::test]
    async fn default_tools_list_matches_the_pre_migration_golden() {
        let state = test_state();
        let response = handle_rpc(&state, &rpc("tools/list", json!({}))).await;
        assert_eq!(
            response["result"]["tools"],
            serde_json::from_str::<Value>(PRE_MIGRATION_TOOLS_LIST_JSON)
                .expect("parse golden json"),
            "the default tools/list must be unchanged by the plugin migration"
        );
    }

    /// Disabling a plugin removes its tools from `tools/list`; the core
    /// tools and the other plugin's tools stay.
    #[tokio::test]
    async fn tools_list_drops_a_deactivated_plugins_tools() {
        let state = test_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable sftp");

        let response = handle_rpc(&state, &rpc("tools/list", json!({}))).await;
        let names: Vec<String> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "read_agent_context",
                "reload_config",
                "list_ssh_profiles",
                "list_shell_sessions",
                "execute_command",
                "get_server_status",
            ]
        );
    }

    /// Calling a deactivated plugin's tool keeps the pre-migration error
    /// semantics: unknown tool (-32602), not a silent success.
    #[tokio::test]
    async fn calling_a_deactivated_plugins_tool_is_unknown() {
        let state = test_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable sftp");

        let response = handle_rpc(
            &state,
            &rpc(
                "tools/call",
                json!({"name": "read_remote_file", "arguments": {"sessionId": "s", "path": "/"}}),
            ),
        )
        .await;
        assert_eq!(response["error"]["code"], -32602);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown tool"));
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
            &rpc(
                "tools/call",
                json!({"name": "read_agent_context", "arguments": {}}),
            ),
        )
        .await;
        assert_eq!(response["result"]["isError"], false);
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).expect("json payload");
        assert_eq!(payload["agentsMd"]["content"], "# my instructions");
        assert_eq!(payload["agentsMd"]["exists"], true);
        let skill = payload["eshellConfigSkill"]["content"].as_str().unwrap();
        assert!(skill.contains("eshell-config"));
        // The plugin-dev skill ships in the same response: an agent asked to
        // write a plugin must not have to go looking for it.
        let plugin_skill = payload["eshellPluginDevSkill"]["content"].as_str().unwrap();
        assert!(plugin_skill.contains("eshell-plugin-dev"));
        assert!(payload["eshellPluginDevSkill"]["path"]
            .as_str()
            .unwrap()
            .ends_with("SKILL.md"));
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
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tools only"));
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
