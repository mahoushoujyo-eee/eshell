//! Constants for the agent domain: ACP stream stage markers, storage file
//! names and the local MCP bridge protocol limits.

/// Streaming stage values bridged onto the `acp-agent-stream` Tauri event.
/// Turn completion is carried by the `acp_session_prompt` response, not a
/// separate event; errors surface through the command's `Err` payload, and
/// connection loss through the `stopped` stage.
pub const STAGE_DELTA: &str = "delta";
pub const STAGE_USER: &str = "user";
pub const STAGE_THOUGHT: &str = "thought";
pub const STAGE_TOOL_CALL: &str = "tool_call";
pub const STAGE_TOOL_UPDATE: &str = "tool_call_update";
pub const STAGE_PLAN: &str = "plan";
pub const STAGE_COMMANDS: &str = "commands";
pub const STAGE_MODE: &str = "mode";
pub const STAGE_CONFIG_OPTIONS: &str = "config_options";
pub const STAGE_USAGE: &str = "usage";
pub const STAGE_PERMISSION_REQUEST: &str = "permission_request";
pub const STAGE_PERMISSION_RESOLVED: &str = "permission_resolved";
pub const STAGE_STOPPED: &str = "stopped";

/// File name of the agent config under `.eshell-data/`.
pub(crate) const ACP_AGENTS_FILE: &str = "acp_agents.json";

/// Directory under `.eshell-data/` holding one JSON file per session transcript.
pub(crate) const ACP_SESSIONS_DIR: &str = "acp_sessions";

/// Stored as `.eshell-data/projects.json`.
pub(crate) const PROJECTS_FILE: &str = "projects.json";

pub(crate) const MCP_PATH: &str = "/mcp";
pub(crate) const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Tool output is embedded in the agent's context; keep it bounded.
pub(crate) const MAX_TOOL_TEXT_CHARS: usize = 60_000;
pub(crate) const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
pub(crate) const FALLBACK_PROTOCOL_VERSION: &str = "2025-03-26";

/// The bundled skills this tool serves, in the order they appear in the
/// response. Each is seeded into `.eshell-data/agent/skills/<dir>/SKILL.md`
/// at startup (see `storage::seed_agent_context`).
pub(crate) const BUNDLED_SKILLS: &[(&str, &str)] = &[
    ("eshell-config", "eshellConfigSkill"),
    ("eshell-plugin-dev", "eshellPluginDevSkill"),
];
