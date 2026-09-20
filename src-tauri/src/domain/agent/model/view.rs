//! Frontend-facing views of ACP protocol data.
//!
//! These are the `Serialize`-only shapes the panel consumes: the
//! `acp-agent-stream` event payload and the results of `acp_agent_start` /
//! `acp_agent_authenticate`. They are deliberately flat — the frontend never
//! sees the SDK's tagged enums.

use agent_client_protocol::schema::v1::SessionConfigOption;
use serde::Serialize;
use serde_json::Value;

/// Streaming stage values bridged onto the `acp-agent-stream` Tauri event.
/// Turn completion is carried by the `acp_session_prompt` response, not a
/// separate event; errors surface through the command's `Err` payload, and
/// connection loss through the `stopped` stage.
/// Payload emitted on the `acp-agent-stream` event channel (camelCase for the frontend).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStreamEvent {
    pub agent_id: String,
    pub session_id: String,
    pub stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<AcpToolCallView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<AcpPlanEntryView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<AcpCommandView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_mode_id: Option<String>,
    /// Full replacement set of session config options (model, thought level,
    /// ...). Forwarded as the SDK type so unknown categories, grouped selects
    /// and `_meta` survive untouched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<AcpUsageView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<AcpPermissionRequestView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_resolution: Option<AcpPermissionResolutionView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AcpStreamEvent {
    pub(crate) fn new(agent_id: &str, session_id: impl Into<String>, stage: &'static str) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            session_id: session_id.into(),
            stage,
            chunk: None,
            tool_call: None,
            plan: None,
            commands: None,
            current_mode_id: None,
            config_options: None,
            usage: None,
            permission: None,
            permission_resolution: None,
            error: None,
        }
    }
}

/// Flat tool-call view consumed by the frontend panel. For `tool_call` events
/// every descriptive field is set; for `tool_call_update` only changed fields
/// are present and the frontend merges them by `toolCallId`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCallView {
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<AcpToolContentView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<AcpToolLocationView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<Value>,
}

/// Tool-call content block: streamed output text, a file diff, or an
/// agent-managed terminal reference.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpToolContentView {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        old_text: Option<String>,
        new_text: String,
    },
    #[serde(rename_all = "camelCase")]
    Terminal { terminal_id: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolLocationView {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPlanEntryView {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCommandView {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpUsageView {
    pub used: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOptionView {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequestView {
    pub request_id: String,
    pub tool_call: AcpToolCallView,
    pub options: Vec<AcpPermissionOptionView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionResolutionView {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    pub cancelled: bool,
}

/// Session modes advertised by the agent at session creation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModesView {
    pub current_mode_id: String,
    pub available_modes: Vec<AcpModeView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModeView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentInfoView {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A sign-in method advertised by the agent during `initialize`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethodView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Capabilities the agent advertised during `initialize`, filtered to what
/// the panel acts on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentCapsView {
    /// Agent supports `session/load` (native history resume).
    pub load_session: bool,
    /// Agent accepts image content blocks in prompts.
    pub prompt_image: bool,
}

/// Result of `start` (and of `authenticate`, once sign-in succeeds).
///
/// When the agent rejects session creation with AUTH_REQUIRED, the connection
/// is kept alive and `auth_required` is set together with the advertised
/// methods; `acp_agent_authenticate` completes the session afterwards.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStartInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub auth_methods: Vec<AcpAuthMethodView>,
    /// True when a requested `session/load` resume actually succeeded; a
    /// resume that fell back to a fresh session reports `false`.
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<AcpAgentCapsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<AcpModesView>,
    /// Session config options advertised at session creation (both Codex and
    /// Claude Code ship model + thought-level selectors here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_info: Option<AcpAgentInfoView>,
    /// Working directory the session actually got, echoed back so the panel can
    /// record where a session ran (and resume it there).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Tauri app handle abstraction so the event loop stays decoupled from Tauri.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: AcpStreamEvent);
}

/// Adapter implementing [`EventSink`] on a `tauri::AppHandle`.
pub struct TauriEventSink(pub tauri::AppHandle);

impl EventSink for TauriEventSink {
    fn emit(&self, event: AcpStreamEvent) {
        use tauri::Emitter as _;
        let _ = self.0.emit("acp-agent-stream", &event);
    }
}

/// Result of one finished prompt turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResult {
    pub stop_reason: Option<String>,
}

/// One image attachment for a prompt turn (base64 payload + mime type).
#[derive(Debug, Clone)]
pub struct AcpPromptImage {
    pub data: String,
    pub mime_type: String,
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
