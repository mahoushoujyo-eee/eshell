//! Agent domain data structures: ACP spawn configuration, session history
//! records, project registry rows and the wire inputs the command surface
//! decodes.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use agent_client_protocol::schema::v1::{
    McpServer, SessionConfigOptionValue,
    SessionConfigValueId,
};
use agent_client_protocol::AcpAgent;
use serde::{Deserialize, Serialize};

use crate::common::error::{AppError, AppResult};
use crate::domain::agent::consts::{ACP_AGENTS_FILE, ACP_SESSIONS_DIR};
use crate::domain::agent::service::acp_client::AcpSessionRunner;

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

/// Default agent set written on first run.
///
/// Each entry is launched through `npx`, so a missing adapter is fetched on
/// first start rather than being a hard install prerequisite. Windows needs the
/// `cmd /c` shim because npm installs its launchers as `.cmd` scripts, which
/// `CreateProcess` cannot execute directly.
pub fn default_agents() -> Vec<AcpAgentSpawnConfig> {
    // (id, display name, npx arguments)
    const DEFAULTS: [(&str, &str, &[&str]); 3] = [
        ("codex", "Codex", &["-y", "@agentclientprotocol/codex-acp"]),
        (
            "claude",
            "Claude Code",
            &["-y", "@agentclientprotocol/claude-agent-acp"],
        ),
        ("opencode", "OpenCode", &["-y", "opencode-ai", "acp"]),
    ];

    DEFAULTS
        .iter()
        .map(|(id, name, npx_args)| {
            let (command, args): (String, Vec<String>) = if cfg!(windows) {
                let mut args = vec!["/c".to_string(), "npx".to_string()];
                args.extend(npx_args.iter().map(|arg| arg.to_string()));
                ("cmd".to_string(), args)
            } else {
                (
                    "npx".to_string(),
                    npx_args.iter().map(|arg| arg.to_string()).collect(),
                )
            };

            AcpAgentSpawnConfig {
                id: (*id).to_string(),
                name: (*name).to_string(),
                command,
                args,
                env: HashMap::new(),
                cwd: None,
                mcp_servers: Vec::new(),
                eshell_tools: true,
            }
        })
        .collect()
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
    pub(crate) fn session_cwd(&self) -> std::path::PathBuf {
        match &self.cwd {
            Some(cwd) if !cwd.trim().is_empty() => std::path::PathBuf::from(cwd),
            _ => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        }
    }
}

/// Registry of session runners keyed by agent id.
#[derive(Default)]
pub struct AcpAgentRegistry {
    pub(crate) runners: RwLock<HashMap<String, Arc<AcpSessionRunner>>>,
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
/// `cwd` overrides the agent config's directory for this session (it is how a
/// project's folder reaches `session/new`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentStartInput {
    pub agent_id: String,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Input for `acp_session_new`: opens another session, optionally in a
/// different project directory, on the already-running agent process.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionNewInput {
    pub agent_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Turns an optional raw path from the frontend into a session cwd, ignoring
/// blank strings so an empty project field falls back to the agent config.
pub(crate) fn session_cwd_override(cwd: Option<String>) -> Option<std::path::PathBuf> {
    cwd.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
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
pub(crate) fn config_option_value(raw: serde_json::Value) -> AppResult<SessionConfigOptionValue> {
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
    /// Session directory this agent resolves to when no project is chosen:
    /// its `cwd` setting, or the app process's current directory. Surfaced so
    /// the panel can show where "no project" sessions actually run.
    pub cwd: String,
}

pub(crate) fn find_config<'a>(
    configs: &'a [AcpAgentSpawnConfig],
    agent_id: &str,
) -> AppResult<&'a AcpAgentSpawnConfig> {
    configs
        .iter()
        .find(|config| config.id == agent_id)
        .ok_or_else(|| AppError::NotFound(format!("unknown acp agent `{agent_id}`")))
}

/// Looks up or creates the runner entry for an agent id.
pub(crate) fn lookup_runner(registry: &AcpAgentRegistry, agent_id: &str) -> Arc<AcpSessionRunner> {
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

// ---------- Local session history ----------
//
// Transcripts are persisted app-side under `.eshell-data/acp_sessions/` so the
// panel can list and reopen past conversations even when the agent itself
// cannot (`session/load` resume is attempted when the agent supports it).

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
    /// Project this session ran in; `None` for sessions started without one
    /// (and for records written before projects existed).
    #[serde(default)]
    pub project_id: Option<String>,
    /// Session working directory, so a resume reopens in the same folder.
    #[serde(default)]
    pub cwd: Option<String>,
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
    pub project_id: Option<String>,
    pub cwd: Option<String>,
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

pub(crate) fn history_dir(state: &crate::state::AppState) -> std::path::PathBuf {
    state.storage.data_dir().join(ACP_SESSIONS_DIR)
}

/// Session ids come from the agent; keep only filesystem-safe characters.
pub(crate) fn history_file_name(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    format!("{sanitized}.json")
}
