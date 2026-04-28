use chrono::Utc;
use serde::{Deserialize, Serialize};

/// Returns current UTC timestamp in RFC3339 format for storage and API responses.
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

pub fn default_ai_max_context_tokens() -> u32 {
    100_000
}

pub fn default_ai_approval_mode() -> AiApprovalMode {
    AiApprovalMode::RequireApproval
}

pub fn default_ai_api_type() -> AiApiType {
    AiApiType::OpenAiChatCompletions
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSession {
    pub id: String,
    pub config_id: String,
    pub config_name: String,
    pub current_dir: String,
    pub last_output: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCommandInput {
    pub session_id: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionResult {
    pub session_id: String,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub current_dir: String,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SftpEntryType {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub entry_type: SftpEntryType,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResponse {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListInput {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpReadInput {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpWriteInput {
    pub session_id: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpCreateInput {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpUploadInput {
    pub session_id: String,
    pub remote_path: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpUploadWithProgressInput {
    pub session_id: String,
    pub remote_path: String,
    pub content_base64: String,
    pub transfer_id: String,
    pub local_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDownloadInput {
    pub session_id: String,
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDownloadToLocalInput {
    pub session_id: String,
    pub remote_path: String,
    pub local_dir: String,
    pub transfer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDeleteInput {
    pub session_id: String,
    pub path: String,
    pub entry_type: SftpEntryType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpCancelTransferInput {
    pub transfer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDownloadPayload {
    pub path: String,
    pub file_name: String,
    pub content_base64: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResult {
    pub transfer_id: String,
    pub direction: String,
    pub remote_path: String,
    pub local_path: String,
    pub file_name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferEvent {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: String,
    pub stage: String,
    pub remote_path: String,
    pub local_path: Option<String>,
    pub file_name: String,
    pub transferred_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: f64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    pub used_mb: f64,
    pub total_mb: f64,
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceStatus {
    pub interface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub pid: i32,
    pub cpu_percent: f64,
    pub memory_mb: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStatus {
    pub filesystem: String,
    pub mount_point: String,
    pub used: String,
    pub total: String,
    pub used_percent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub cpu_percent: f64,
    pub memory: MemoryStatus,
    pub network_interfaces: Vec<NetworkInterfaceStatus>,
    pub selected_interface: Option<String>,
    pub selected_interface_traffic: Option<NetworkInterfaceStatus>,
    pub top_processes: Vec<ProcessStatus>,
    pub disks: Vec<DiskStatus>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchServerStatusInput {
    pub session_id: String,
    pub selected_interface: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDefinition {
    pub id: String,
    pub name: String,
    pub path: String,
    pub command: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInput {
    pub id: Option<String>,
    pub name: String,
    pub path: Option<String>,
    pub command: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptInput {
    pub session_id: String,
    pub script_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptResult {
    pub script_id: String,
    pub script_name: String,
    pub execution: CommandExecutionResult,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiProfilesState {
    pub profiles: Vec<AiProfile>,
    pub active_profile_id: Option<String>,
    #[serde(default = "default_ai_approval_mode")]
    pub approval_mode: AiApprovalMode,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenShellInput {
    pub config_id: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseShellInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelShellConnectionInput {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyWriteInput {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResizeInput {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub session_id: String,
    pub chunk: String,
}
