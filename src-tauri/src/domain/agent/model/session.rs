//! Wire inputs decoded by the `acp_*` command surface.
//!
//! Every type here is a `Deserialize`-only shape for one Tauri command; the
//! matching result types live in [`super::view`].

use agent_client_protocol::schema::v1::{SessionConfigOptionValue, SessionConfigValueId};
use serde::Deserialize;

use crate::common::error::{AppError, AppResult};

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
