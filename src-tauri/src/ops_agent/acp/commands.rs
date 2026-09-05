//! Tauri command surface for ACP agents: list/start/stop agents, create
//! sessions, send prompts, cancel turns, resolve permission requests, and
//! switch session modes.
//!
//! Registry: one [`AcpSessionRunner`] per configured agent id, held in
//! application state. Agent spawn commands come from `.eshell-data/acp_agents.json`
//! (defaults written on first run; Windows default routes npx through cmd).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use agent_client_protocol::schema::v1::{
    HttpHeader, McpServer, McpServerHttp, SessionConfigOption, SessionConfigOptionValue,
    SessionConfigValueId,
};
use agent_client_protocol::AcpAgent;
use serde::{Deserialize, Serialize};

use super::client::{
    AcpPromptImage, AcpPromptResult, AcpSessionRunner, AcpStartInfo, TauriEventSink,
};
use crate::error::{AppError, AppResult};

/// File name of the agent config under `.eshell-data/`.
const ACP_AGENTS_FILE: &str = "acp_agents.json";

/// Spawn configuration for one agent, stored in `acp_agents.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpAgentSpawnConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Session working directory handed to `session/new`; defaults to the
    /// app's current directory when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// MCP servers passed through to the agent at session creation, in ACP
    /// wire format (http/sse/stdio entries).
    #[serde(default, rename = "mcpServers", skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServer>,
    /// Whether to inject eShell's own MCP bridge (SSH sessions, remote exec,
    /// SFTP tools) into this agent's sessions. Defaults to true.
    #[serde(default = "default_true", rename = "eshellTools")]
    pub eshell_tools: bool,
}

fn default_true() -> bool {
    true
}

/// Default agent set written on first run. Windows needs the cmd shim for
/// npm-installed `.cmd` launchers.
pub fn default_agents() -> Vec<AcpAgentSpawnConfig> {
    let (command, args): (String, Vec<String>) = if cfg!(windows) {
        (
            "cmd".to_string(),
            vec![
                "/c".to_string(),
                "npx".to_string(),
                "-y".to_string(),
                "@agentclientprotocol/codex-acp".to_string(),
            ],
        )
    } else {
        (
            "npx".to_string(),
            vec![
                "-y".to_string(),
                "@agentclientprotocol/codex-acp".to_string(),
            ],
        )
    };
    vec![AcpAgentSpawnConfig {
        id: "codex".to_string(),
        name: "Codex".to_string(),
        command,
        args,
        env: HashMap::new(),
        cwd: None,
        mcp_servers: Vec::new(),
        eshell_tools: true,
    }]
}

impl AcpAgentSpawnConfig {
    /// Builds the SDK spawn handle from this config.
    pub fn to_acp_agent(&self) -> AcpAgent {
        AcpAgent::new(
            agent_client_protocol::AcpAgentConfig::new(&self.command)
                .args(self.args.iter().cloned())
                .envs(self.env.iter().map(|(k, v)| (k.clone(), v.clone()))),
        )
    }

    /// Resolves the session working directory for this agent.
    fn session_cwd(&self) -> std::path::PathBuf {
        match &self.cwd {
            Some(cwd) if !cwd.trim().is_empty() => std::path::PathBuf::from(cwd),
            _ => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        }
    }
}

/// Registry of session runners keyed by agent id.
#[derive(Default)]
pub struct AcpAgentRegistry {
    runners: RwLock<HashMap<String, Arc<AcpSessionRunner>>>,
}

impl AcpAgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Loads agent configs, creating the default file on first run.
pub fn load_agent_configs(storage_root: &std::path::Path) -> AppResult<Vec<AcpAgentSpawnConfig>> {
    let path = storage_root.join(ACP_AGENTS_FILE);
    if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(AppError::Io)?;
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(default = "default_agents")]
            agents: Vec<AcpAgentSpawnConfig>,
        }
        let wrapper: Wrapper = serde_json::from_str(&raw)?;
        Ok(wrapper.agents)
    } else {
        let agents = default_agents();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let serialized = serde_json::to_string_pretty(&AgentConfigFile {
            agents: agents.clone(),
        })?;
        let _ = std::fs::write(&path, serialized);
        Ok(agents)
    }
}

#[derive(Serialize, Deserialize)]
struct AgentConfigFile {
    agents: Vec<AcpAgentSpawnConfig>,
}

/// Input for `acp_agent_stop`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentIdInput {
    pub agent_id: String,
}

/// Input for `acp_agent_start`. `resume_session_id` asks for a `session/load`
/// resume; agents without that capability fall back to a fresh session.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentStartInput {
    pub agent_id: String,
    #[serde(default)]
    pub resume_session_id: Option<String>,
}

/// One prompt image attachment (base64 payload, e.g. from the composer).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptImageInput {
    pub data: String,
    pub mime_type: String,
}

/// Input for `acp_session_prompt`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionPromptInput {
    pub agent_id: String,
    pub session_id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<AcpPromptImageInput>,
}

/// Input for `acp_session_cancel`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionCancelInput {
    pub agent_id: String,
    pub session_id: String,
}

/// Input for `acp_permission_respond`. `option_id: None` cancels the request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRespondInput {
    pub agent_id: String,
    pub request_id: String,
    #[serde(default)]
    pub option_id: Option<String>,
}

/// Input for `acp_session_set_mode`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionSetModeInput {
    pub agent_id: String,
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionSetConfigOptionInput {
    pub agent_id: String,
    pub session_id: String,
    pub config_id: String,
    /// Bare value from the panel: a value id string for `select` options, a bool
    /// for `boolean` ones. Converted to the SDK enum below so the frontend never
    /// has to encode ACP's `type` discriminator.
    pub value: serde_json::Value,
}

/// Maps a bare JSON scalar onto the SDK's tagged value enum.
fn config_option_value(raw: serde_json::Value) -> AppResult<SessionConfigOptionValue> {
    match raw {
        serde_json::Value::Bool(value) => Ok(SessionConfigOptionValue::Boolean { value }),
        serde_json::Value::String(value) => Ok(SessionConfigOptionValue::ValueId {
            value: SessionConfigValueId::new(value),
        }),
        other => Err(AppError::Validation(format!(
            "unsupported acp config option value: {other}"
        ))),
    }
}

/// Input for `acp_agent_authenticate`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthenticateInput {
    pub agent_id: String,
    pub method_id: String,
}

/// Result row for `acp_agent_list`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentListEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub running: bool,
}

fn find_config<'a>(
    configs: &'a [AcpAgentSpawnConfig],
    agent_id: &str,
) -> AppResult<&'a AcpAgentSpawnConfig> {
    configs
        .iter()
        .find(|config| config.id == agent_id)
        .ok_or_else(|| AppError::NotFound(format!("unknown acp agent `{agent_id}`")))
}

/// Looks up or creates the runner entry for an agent id.
fn lookup_runner(registry: &AcpAgentRegistry, agent_id: &str) -> Arc<AcpSessionRunner> {
    {
        let read = registry.runners.read().unwrap();
        if let Some(runner) = read.get(agent_id) {
            return Arc::clone(runner);
        }
    }
    let mut write = registry.runners.write().unwrap();
    if let Some(runner) = write.get(agent_id) {
        return Arc::clone(runner);
    }
    let runner = Arc::new(AcpSessionRunner::new(agent_id));
    write.insert(agent_id.to_string(), Arc::clone(&runner));
    runner
}

/// Lists configured agents with running state.
#[tauri::command]
pub async fn acp_agent_list(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<Vec<AcpAgentListEntry>, String> {
    let configs =
        load_agent_configs(&state.storage.data_dir()).map_err(crate::error::to_command_error)?;
    let runners: HashMap<String, Arc<AcpSessionRunner>> = {
        let read = state.acp_agents.runners.read().unwrap();
        read.iter()
            .map(|(id, runner)| (id.clone(), Arc::clone(runner)))
            .collect()
    };
    let mut entries = Vec::with_capacity(configs.len());
    for config in configs {
        let running = match runners.get(&config.id) {
            Some(runner) => runner.is_running().await,
            None => false,
        };
        entries.push(AcpAgentListEntry {
            running,
            id: config.id,
            name: config.name,
            command: config.command,
            args: config.args,
        });
    }
    Ok(entries)
}

/// Spawns one agent, handshakes, and creates (or resumes) its session.
/// Returns the session id plus the modes, capabilities, and agent info
/// advertised during the handshake.
#[tauri::command]
pub async fn acp_agent_start(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    app: tauri::AppHandle,
    input: AcpAgentStartInput,
) -> Result<AcpStartInfo, String> {
    let configs =
        load_agent_configs(&state.storage.data_dir()).map_err(crate::error::to_command_error)?;
    let config = find_config(&configs, &input.agent_id)
        .map_err(crate::error::to_command_error)?
        .clone();

    let runner = lookup_runner(&state.acp_agents, &config.id);
    if runner.is_running().await {
        return Err(format!(
            "acp agent `{}` already has an active session",
            config.id
        ));
    }

    let sink = Arc::new(TauriEventSink(app));
    let mut mcp_servers = config.mcp_servers.clone();
    // Give the agent eShell's own toolset (open sessions, remote exec, SFTP)
    // through the local MCP bridge, unless this agent opted out.
    if config.eshell_tools {
        if let Some(bridge) = state.mcp_bridge() {
            mcp_servers.push(McpServer::Http(
                McpServerHttp::new("eshell", format!("http://127.0.0.1:{}/mcp", bridge.port))
                    .headers(vec![HttpHeader::new(
                        "Authorization",
                        format!("Bearer {}", bridge.token),
                    )]),
            ));
        }
    }
    runner
        .start(
            config.to_acp_agent(),
            config.session_cwd(),
            mcp_servers,
            input.resume_session_id,
            sink,
        )
        .await
}

/// Stops one agent session and drops its runner entry.
#[tauri::command]
pub async fn acp_agent_stop(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpAgentIdInput,
) -> Result<(), String> {
    let runner = {
        let mut write = state.acp_agents.runners.write().unwrap();
        write.remove(&input.agent_id)
    };
    if let Some(runner) = runner {
        runner.stop().await;
    }
    Ok(())
}

/// Sends one prompt turn (text plus optional images) on an existing session.
#[tauri::command]
pub async fn acp_session_prompt(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionPromptInput,
) -> Result<AcpPromptResult, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    let images = input
        .images
        .into_iter()
        .map(|image| AcpPromptImage {
            data: image.data,
            mime_type: image.mime_type,
        })
        .collect();
    runner.prompt(&input.session_id, &input.text, images).await
}

/// Cancels the in-flight turn; pending permission requests resolve as cancelled.
#[tauri::command]
pub async fn acp_session_cancel(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionCancelInput,
) -> Result<(), String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.resolve_pending_permissions_cancelled();
    runner.cancel(&input.session_id).await
}

/// Resolves one pending permission request with the user's decision.
#[tauri::command]
pub async fn acp_permission_respond(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpPermissionRespondInput,
) -> Result<(), String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.respond_permission(&input.request_id, input.option_id.as_deref())
}

/// Switches the session mode.
#[tauri::command]
pub async fn acp_session_set_mode(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionSetModeInput,
) -> Result<(), String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.set_mode(&input.session_id, &input.mode_id).await
}

/// Sets one session config option (model, thought level, ...) and returns the
/// agent's full updated option set, which the panel swaps in wholesale.
#[tauri::command]
pub async fn acp_session_set_config_option(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionSetConfigOptionInput,
) -> Result<Vec<SessionConfigOption>, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    let value = config_option_value(input.value).map_err(crate::error::to_command_error)?;
    runner
        .set_config_option(&input.session_id, &input.config_id, value)
        .await
}

/// Runs the agent's sign-in flow for one advertised auth method and, on
/// success, creates the session the initial start could not.
#[tauri::command]
pub async fn acp_agent_authenticate(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpAuthenticateInput,
) -> Result<AcpStartInfo, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.authenticate(&input.method_id).await
}

fn get_runner(
    state: &tauri::State<'_, Arc<crate::state::AppState>>,
    agent_id: &str,
) -> Result<Arc<AcpSessionRunner>, String> {
    let read = state.acp_agents.runners.read().unwrap();
    read.get(agent_id)
        .map(Arc::clone)
        .ok_or_else(|| format!("acp agent `{agent_id}` is not started"))
}

// ---------- Local session history ----------
//
// Transcripts are persisted app-side under `.eshell-data/acp_sessions/` so the
// panel can list and reopen past conversations even when the agent itself
// cannot (`session/load` resume is attempted when the agent supports it).

/// Directory under `.eshell-data/` holding one JSON file per session.
const ACP_SESSIONS_DIR: &str = "acp_sessions";

/// One persisted session transcript. `transcript` is the panel's own entry
/// array, stored verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryRecord {
    pub id: String,
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub transcript: serde_json::Value,
}

/// List row: everything except the transcript body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryMeta {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub entry_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistorySaveInput {
    pub record: AcpHistoryRecord,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryIdInput {
    pub id: String,
}

fn history_dir(state: &crate::state::AppState) -> std::path::PathBuf {
    state.storage.data_dir().join(ACP_SESSIONS_DIR)
}

/// Session ids come from the agent; keep only filesystem-safe characters.
fn history_file_name(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(96)
        .collect();
    format!("{sanitized}.json")
}

/// Persists (or overwrites) one session transcript.
#[tauri::command]
pub async fn acp_history_save(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpHistorySaveInput,
) -> Result<(), String> {
    let mut record = input.record;
    if record.id.trim().is_empty() {
        return Err("history record id is empty".to_string());
    }
    record.updated_at = crate::models::now_rfc3339();
    if record.created_at.trim().is_empty() {
        record.created_at = record.updated_at.clone();
    }

    let dir = history_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(history_file_name(&record.id));
    let serialized = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    std::fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Lists persisted sessions, newest first.
#[tauri::command]
pub async fn acp_history_list(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<Vec<AcpHistoryMeta>, String> {
    let dir = history_dir(&state);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<AcpHistoryRecord>(&raw) else {
            continue;
        };
        rows.push(AcpHistoryMeta {
            entry_count: record.transcript.as_array().map(Vec::len).unwrap_or(0),
            id: record.id,
            agent_id: record.agent_id,
            agent_name: record.agent_name,
            title: record.title,
            created_at: record.created_at,
            updated_at: record.updated_at,
        });
    }
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

/// Loads one persisted session transcript.
#[tauri::command]
pub async fn acp_history_get(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpHistoryIdInput,
) -> Result<AcpHistoryRecord, String> {
    let path = history_dir(&state).join(history_file_name(&input.id));
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| format!("acp session history `{}` not found", input.id))?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Deletes one persisted session transcript.
#[tauri::command]
pub async fn acp_history_delete(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpHistoryIdInput,
) -> Result<(), String> {
    let path = history_dir(&state).join(history_file_name(&input.id));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("delete {}: {err}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_agents_use_cmd_shim_on_windows() {
        let agents = default_agents();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "codex");
        if cfg!(windows) {
            assert_eq!(agents[0].command, "cmd");
            assert_eq!(agents[0].args[0], "/c");
            assert!(agents[0].args.contains(&"@agentclientprotocol/codex-acp".to_string()));
        }
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
        assert_eq!(agent.config().command(), std::path::Path::new(&config.command));
    }

    #[test]
    fn history_file_name_sanitizes_session_ids() {
        assert_eq!(history_file_name("abc-123_XY"), "abc-123_XY.json");
        assert_eq!(history_file_name("a/b\\c:d*e"), "a_b_c_d_e.json");
        let long = "x".repeat(200);
        assert_eq!(history_file_name(&long).len(), 96 + ".json".len());
    }
}
