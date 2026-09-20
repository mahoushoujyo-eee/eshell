//! Agent spawn configuration and the runner registry.
//!
//! `acp_agents.json` is the persisted form of [`AcpAgentSpawnConfig`]; the
//! registry holds one live [`AcpSessionRunner`] per agent id.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::AcpAgent;
use serde::{Deserialize, Serialize};

use crate::common::error::{AppError, AppResult};
use crate::domain::agent::consts::ACP_AGENTS_FILE;
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
