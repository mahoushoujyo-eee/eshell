//! AI configuration, model profiles and agent context files.

use serde::{Deserialize, Serialize};

use super::common::now_rfc3339;

pub fn default_ai_max_context_tokens() -> u32 {
    100_000
}

pub fn default_ai_approval_mode() -> AiApprovalMode {
    AiApprovalMode::RequireApproval
}

pub fn default_ai_agent_mode() -> AiAgentMode {
    AiAgentMode::Pro
}

pub fn default_ai_api_type() -> AiApiType {
    AiApiType::OpenAiChatCompletions
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AiApprovalMode {
    RequireApproval,
    AutoExecute,
}

impl Default for AiApprovalMode {
    fn default() -> Self {
        default_ai_approval_mode()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiAgentMode {
    Lite,
    Pro,
    Auto,
}

impl Default for AiAgentMode {
    fn default() -> Self {
        default_ai_agent_mode()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AiApiType {
    #[serde(rename = "openai_chat_completions")]
    OpenAiChatCompletions,
    #[serde(rename = "openai_responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic_messages")]
    AnthropicMessages,
}

impl Default for AiApiType {
    fn default() -> Self {
        default_ai_api_type()
    }
}

impl AiApiType {
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Self::OpenAiChatCompletions | Self::OpenAiResponses => "https://api.openai.com/v1",
            Self::AnthropicMessages => "https://api.anthropic.com",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default = "default_ai_api_type")]
    pub api_type: AiApiType,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: f64,
    pub max_tokens: u32,
    #[serde(default = "default_ai_max_context_tokens")]
    pub max_context_tokens: u32,
    #[serde(default = "default_ai_approval_mode")]
    pub approval_mode: AiApprovalMode,
    #[serde(default = "default_ai_agent_mode")]
    pub agent_mode: AiAgentMode,
    pub updated_at: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        let api_type = default_ai_api_type();
        Self {
            api_type: api_type.clone(),
            base_url: api_type.default_base_url().to_string(),
            api_key: String::new(),
            model: "gpt-4o-mini".to_string(),
            system_prompt: "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.".to_string(),
            temperature: 0.2,
            max_tokens: 800,
            max_context_tokens: default_ai_max_context_tokens(),
            approval_mode: default_ai_approval_mode(),
            agent_mode: default_ai_agent_mode(),
            updated_at: now_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigInput {
    #[serde(default = "default_ai_api_type")]
    pub api_type: AiApiType,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: f64,
    pub max_tokens: u32,
    #[serde(default = "default_ai_max_context_tokens")]
    pub max_context_tokens: u32,
    #[serde(default = "default_ai_approval_mode")]
    pub approval_mode: AiApprovalMode,
    #[serde(default = "default_ai_agent_mode")]
    pub agent_mode: AiAgentMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    #[serde(default = "default_ai_api_type")]
    pub api_type: AiApiType,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: f64,
    pub max_tokens: u32,
    #[serde(default = "default_ai_max_context_tokens")]
    pub max_context_tokens: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default = "default_ai_api_type")]
    pub api_type: AiApiType,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: f64,
    pub max_tokens: u32,
    #[serde(default = "default_ai_max_context_tokens")]
    pub max_context_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProfilesState {
    pub profiles: Vec<AiProfile>,
    pub active_profile_id: Option<String>,
    #[serde(default = "default_ai_approval_mode")]
    pub approval_mode: AiApprovalMode,
    #[serde(default = "default_ai_agent_mode")]
    pub agent_mode: AiAgentMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveAiProfileInput {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiApprovalModeInput {
    #[serde(default = "default_ai_approval_mode")]
    pub approval_mode: AiApprovalMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiAgentModeInput {
    #[serde(default = "default_ai_agent_mode")]
    pub agent_mode: AiAgentMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextInput {
    #[serde(default)]
    pub server_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentContextInput {
    #[serde(default)]
    pub server_id: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextContent {
    #[serde(default)]
    pub server_id: Option<String>,
    pub content: String,
    /// Whether the backing file already exists on disk.
    pub exists: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextFile {
    #[serde(default)]
    pub server_id: Option<String>,
    pub exists: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextList {
    pub global: AgentContextFile,
    pub servers: Vec<AgentContextFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentContextInput {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAskInput {
    pub session_id: Option<String>,
    pub question: String,
    pub include_last_output: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub answer: String,
    pub suggested_command: Option<String>,
}
