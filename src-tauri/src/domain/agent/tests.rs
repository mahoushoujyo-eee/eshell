//! Agent domain tests: ACP client event translation, command/config
//! helpers, project registry and the local MCP bridge. Grouped by source
//! module; each section imports from the real module path.

// ---------------------------------------------------------------------------
// acp_client
// ---------------------------------------------------------------------------

use std::path::Path;

use agent_client_protocol::schema::v1::{
    AuthMethod, ContentChunk, ContentBlock, CurrentModeUpdate, Plan, PlanEntry, PlanEntryPriority,
    PlanEntryStatus, SessionConfigOptionValue, SessionId, SessionModeId, SessionNotification,
    SessionUpdate, TextContent, ToolCall, ToolCallId, ToolKind,
};

use crate::domain::agent::consts::*;
use crate::domain::agent::model::*;
use crate::domain::agent::service::acp_client::*;
use crate::domain::agent::service::projects::*;

fn notification(update: SessionUpdate) -> SessionNotification {
    SessionNotification::new(SessionId::new("test-session"), update)
}

#[test]
fn message_chunk_becomes_delta_event() {
    let notification = notification(SessionUpdate::AgentMessageChunk(ContentChunk::new(
        ContentBlock::Text(TextContent::new("hello".to_string())),
    )));
    let events = translate_notification("codex", &notification);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].stage, STAGE_DELTA);
    assert_eq!(events[0].chunk.as_deref(), Some("hello"));
    assert_eq!(events[0].agent_id, "codex");
}

#[test]
fn thought_chunk_becomes_thought_event() {
    let notification = notification(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
        ContentBlock::Text(TextContent::new("pondering".to_string())),
    )));
    let events = translate_notification("codex", &notification);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].stage, STAGE_THOUGHT);
    assert_eq!(events[0].chunk.as_deref(), Some("pondering"));
}

#[test]
fn tool_call_becomes_tool_event_with_wire_names() {
    let notification = notification(SessionUpdate::ToolCall(
        ToolCall::new(ToolCallId::from("t1"), "run ls".to_string()).kind(ToolKind::Execute),
    ));
    let events = translate_notification("codex", &notification);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].stage, STAGE_TOOL_CALL);
    let view = events[0].tool_call.as_ref().unwrap();
    assert_eq!(view.tool_call_id, "t1");
    assert_eq!(view.title.as_deref(), Some("run ls"));
    assert_eq!(view.kind.as_deref(), Some("execute"));
    assert_eq!(view.status.as_deref(), Some("pending"));
}

#[test]
fn plan_update_becomes_plan_event() {
    let notification = notification(SessionUpdate::Plan(Plan::new(vec![PlanEntry::new(
        "step one",
        PlanEntryPriority::High,
        PlanEntryStatus::InProgress,
    )])));
    let events = translate_notification("codex", &notification);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].stage, STAGE_PLAN);
    let plan = events[0].plan.as_ref().unwrap();
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].content, "step one");
    assert_eq!(plan[0].priority, "high");
    assert_eq!(plan[0].status, "in_progress");
}

#[test]
fn mode_update_becomes_mode_event() {
    let notification = notification(SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(
        SessionModeId::new("yolo"),
    )));
    let events = translate_notification("codex", &notification);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].stage, STAGE_MODE);
    assert_eq!(events[0].current_mode_id.as_deref(), Some("yolo"));
}

#[test]
fn session_info_updates_are_ignored() {
    let notification = notification(SessionUpdate::SessionInfoUpdate(Default::default()));
    let events = translate_notification("codex", &notification);
    assert!(events.is_empty());
}

#[test]
fn auth_required_error_is_detected_by_code_and_message() {
    let by_code = agent_client_protocol::Error::auth_required();
    assert!(is_auth_required_error(&by_code));

    let by_message = agent_client_protocol::Error::new(-32603, "Authentication required");
    assert!(is_auth_required_error(&by_message));

    let other = agent_client_protocol::Error::new(-32603, "boom");
    assert!(!is_auth_required_error(&other));
}

#[test]
fn auth_method_view_maps_id_name_description() {
    use agent_client_protocol::schema::v1::AuthMethodAgent;
    let method = AuthMethod::Agent(
        AuthMethodAgent::new("chatgpt", "Sign in with ChatGPT")
            .description("Opens a browser".to_string()),
    );
    let view = auth_method_view(&method);
    assert_eq!(view.id, "chatgpt");
    assert_eq!(view.name, "Sign in with ChatGPT");
    assert_eq!(view.description.as_deref(), Some("Opens a browser"));
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[test]
fn default_agents_ship_codex_claude_and_opencode() {
    let agents = default_agents();
    let ids: Vec<&str> = agents.iter().map(|agent| agent.id.as_str()).collect();
    assert_eq!(ids, vec!["codex", "claude", "opencode"]);

    // The frontend resolves brand marks by matching the id/name, so these
    // have to keep matching `acpAgentBrands.js`.
    let names: Vec<&str> = agents.iter().map(|agent| agent.name.as_str()).collect();
    assert_eq!(names, vec!["Codex", "Claude Code", "OpenCode"]);

    for agent in &agents {
        assert!(
            agent.eshell_tools,
            "{} should get the eShell tools",
            agent.id
        );
        let spawn = format!("{} {}", agent.command, agent.args.join(" "));
        assert!(spawn.contains("npx"), "{spawn}");
        if cfg!(windows) {
            // npm installs launchers as `.cmd`, which CreateProcess cannot
            // run directly.
            assert_eq!(agent.command, "cmd");
            assert_eq!(agent.args[0], "/c");
            assert_eq!(agent.args[1], "npx");
        } else {
            assert_eq!(agent.command, "npx");
            assert_eq!(agent.args[0], "-y");
        }
    }
}

/// The reported problem: a fresh install only had Codex in the picker.
/// This covers the write path, not just `default_agents` in isolation.
#[test]
fn first_run_writes_every_default_agent_to_disk() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("eshell-acp-defaults-{nonce}"));
    std::fs::create_dir_all(&root).expect("create temp storage root");

    let first_run = load_agent_configs(&root).expect("first run");
    let ids: Vec<&str> = first_run.iter().map(|agent| agent.id.as_str()).collect();
    assert_eq!(ids, vec!["codex", "claude", "opencode"]);

    let raw = std::fs::read_to_string(root.join(ACP_AGENTS_FILE)).expect("config written");
    assert!(raw.contains("@agentclientprotocol/codex-acp"), "{raw}");
    assert!(raw.contains("@agentclientprotocol/claude-agent-acp"), "{raw}");
    assert!(raw.contains("opencode-ai"), "{raw}");

    // A second launch reads the file back rather than rewriting it.
    let second_run = load_agent_configs(&root).expect("second run");
    assert_eq!(second_run.len(), 3);

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn default_agents_point_at_their_own_adapter() {        let spawn_of = |id: &str| {
        let agents = default_agents();
        let agent = agents
            .into_iter()
            .find(|agent| agent.id == id)
            .unwrap_or_else(|| panic!("missing default agent {id}"));
        agent.args.join(" ")
    };

    assert!(spawn_of("codex").contains("@agentclientprotocol/codex-acp"));
    assert!(spawn_of("claude").contains("@agentclientprotocol/claude-agent-acp"));
    assert!(spawn_of("opencode").contains("opencode-ai acp"));
}

#[test]
fn config_option_value_maps_bare_scalars() {
    let select = config_option_value(serde_json::json!("high")).unwrap();
    assert!(matches!(select, SessionConfigOptionValue::ValueId { .. }));
    let toggle = config_option_value(serde_json::json!(true)).unwrap();
    assert!(matches!(
        toggle,
        SessionConfigOptionValue::Boolean { value: true }
    ));
    // Objects, numbers and the like are not valid option values.
    assert!(config_option_value(serde_json::json!({"value": "high"})).is_err());
    assert!(config_option_value(serde_json::json!(3)).is_err());
}

/// `session/set_config_option` carries the value at the *top level* of the
/// request, not nested under `value.value`: codex-acp validates `value` as
/// `string | boolean` and rejects an object with -32602 (verified against the
/// real agent with `scripts/acp-probe.mjs`). The SDK gets there by flattening
/// the tagged enum, so pin the resulting wire shape — an SDK bump that stops
/// flattening would silently break every model / thought-level change.
#[test]
fn set_config_option_request_keeps_the_value_bare() {
    use agent_client_protocol::schema::v1::{
        SessionConfigId, SessionId, SetSessionConfigOptionRequest,
    };

    let select = SetSessionConfigOptionRequest::new(
        SessionId::new("sess-1"),
        SessionConfigId::new("reasoning_effort"),
        config_option_value(serde_json::json!("high")).unwrap(),
    );
    assert_eq!(
        serde_json::to_value(&select).unwrap(),
        serde_json::json!({
            "sessionId": "sess-1",
            "configId": "reasoning_effort",
            "value": "high",
        })
    );

    let toggle = SetSessionConfigOptionRequest::new(
        SessionId::new("sess-1"),
        SessionConfigId::new("fast-mode"),
        config_option_value(serde_json::json!(true)).unwrap(),
    );
    assert_eq!(
        serde_json::to_value(&toggle).unwrap(),
        serde_json::json!({
            "sessionId": "sess-1",
            "configId": "fast-mode",
            "type": "boolean",
            "value": true,
        })
    );
}

#[test]
fn config_round_trips_through_json() {
    let config = default_agents().remove(0);
    let json = serde_json::to_string(&config).unwrap();
    let parsed: AcpAgentSpawnConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.id, config.id);
    assert_eq!(parsed.args, config.args);
    assert!(parsed.cwd.is_none());
    assert!(parsed.mcp_servers.is_empty());
}

#[test]
fn config_accepts_optional_cwd_and_mcp_servers() {
    let raw = r#"{
        "id": "codex",
        "name": "Codex",
        "command": "codex-acp",
        "cwd": "d:/work/project",
        "mcpServers": [
            {"type": "stdio", "name": "files", "command": "mcp-files", "args": [], "env": []}
        ]
    }"#;
    let parsed: AcpAgentSpawnConfig = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.cwd.as_deref(), Some("d:/work/project"));
    assert_eq!(parsed.mcp_servers.len(), 1);
    assert_eq!(
        parsed.session_cwd(),
        std::path::PathBuf::from("d:/work/project")
    );
}

#[test]
fn builds_sdk_agent_from_config() {
    let config = default_agents().remove(0);
    let agent = config.to_acp_agent();
    assert_eq!(
        agent.config().command(),
        std::path::Path::new(&config.command)
    );
}

#[test]
fn history_file_name_sanitizes_session_ids() {
    assert_eq!(history_file_name("abc-123_XY"), "abc-123_XY.json");
    assert_eq!(history_file_name("a/b\\c:d*e"), "a_b_c_d_e.json");
    let long = "x".repeat(200);
    assert_eq!(history_file_name(&long).len(), 96 + ".json".len());
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "eshell-projects-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn round_trips_projects_through_disk() {
    let dir = temp_dir();
    let project = AcpProject {
        id: "p1".to_string(),
        name: "eshell".to_string(),
        path: "D:/goc/eshell".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
    };
    save(&dir, &[project.clone()]).expect("save");
    let loaded = load(&dir);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].name, "eshell");
    assert_eq!(loaded[0].path, "D:/goc/eshell");
}

#[test]
fn missing_file_reads_as_empty_and_corrupt_file_does_not_panic() {
    let dir = temp_dir();
    assert!(load(&dir).is_empty());
    std::fs::write(projects_path(&dir), "{ not json").expect("write junk");
    assert!(load(&dir).is_empty());
}

#[test]
fn path_comparison_ignores_separator_style_and_trailing_slashes() {
    assert_eq!(
        normalize_for_compare("D:\\goc\\eshell\\"),
        normalize_for_compare("D:/goc/eshell")
    );
}

#[test]
fn project_name_falls_back_to_path_for_roots() {
    assert_eq!(project_name(Path::new("D:/goc/eshell"), "D:/goc/eshell"), "eshell");
    // `Path::file_name` is None for a bare root, so the raw string stands in.
    assert_eq!(project_name(Path::new("/"), "/"), "/");
}

// ---------------------------------------------------------------------------
// mcp_bridge
// ---------------------------------------------------------------------------

// Unit tests for the local MCP bridge: RPC dispatch, the tool surface,
// and the HTTP endpoint's auth contract.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::domain::agent::consts::FALLBACK_PROTOCOL_VERSION;
use crate::domain::agent::service::mcp_bridge::{handle_rpc, start};
use crate::state::AppState;

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

