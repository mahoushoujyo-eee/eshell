use serde::{Deserialize, Serialize};

use crate::models::now_rfc3339;

const SHELL_CONTEXT_MAX_CHARS: usize = 4000;
const SHELL_CONTEXT_PREVIEW_CHARS: usize = 72;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpsAgentRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(transparent)]
pub struct OpsAgentToolKind(String);

impl OpsAgentToolKind {
    pub fn new(value: impl Into<String>) -> Self {
        let normalized = value.into().trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Self::none();
        }
        Self(normalized)
    }

    pub fn none() -> Self {
        Self("none".to_string())
    }

    pub fn read_shell() -> Self {
        Self("read_shell".to_string())
    }

    pub fn write_shell() -> Self {
        Self("write_shell".to_string())
    }

    pub fn shell() -> Self {
        Self("shell".to_string())
    }

    pub fn ui_context() -> Self {
        Self("ui_context".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_none(&self) -> bool {
        self.0.is_empty() || self.0 == "none"
    }
}

impl std::fmt::Display for OpsAgentToolKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsAgentActionStatus {
    Pending,
    Rejected,
    Executed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OpsAgentRiskLevel {
    #[default]
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentShellContext {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default = "default_shell_context_session_name")]
    pub session_name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub char_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentMessage {
    pub id: String,
    pub role: OpsAgentRole,
    pub content: String,
    pub created_at: String,
    #[serde(default)]
    pub tool_kind: Option<OpsAgentToolKind>,
    #[serde(default)]
    pub shell_context: Option<OpsAgentShellContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentConversation {
    pub id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub messages: Vec<OpsAgentMessage>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentConversationSummary {
    pub id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub message_count: usize,
    pub last_message_preview: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentPendingAction {
    pub id: String,
    #[serde(default = "default_pending_action_tool_kind")]
    pub tool_kind: OpsAgentToolKind,
    #[serde(default)]
    pub risk_level: OpsAgentRiskLevel,
    pub conversation_id: String,
    #[serde(default)]
    pub source_user_message_id: Option<String>,
    pub session_id: Option<String>,
    pub command: String,
    pub reason: String,
    pub status: OpsAgentActionStatus,
    pub created_at: String,
    pub updated_at: String,
    pub resolved_at: Option<String>,
    pub execution_output: Option<String>,
    pub execution_exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentData {
    pub conversations: Vec<OpsAgentConversation>,
    pub active_conversation_id: Option<String>,
    pub pending_actions: Vec<OpsAgentPendingAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentCreateConversationInput {
    pub title: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentGetConversationInput {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentDeleteConversationInput {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentSetActiveConversationInput {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentChatInput {
    pub conversation_id: Option<String>,
    pub session_id: Option<String>,
    pub question: String,
    pub shell_context: Option<OpsAgentShellContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentCompactConversationInput {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentCompactConversationResult {
    pub conversation: OpsAgentConversation,
    pub compacted: bool,
    pub note: String,
    pub estimated_tokens_before: usize,
    pub estimated_tokens_after: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentChatAccepted {
    pub run_id: String,
    pub conversation_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsAgentStreamStage {
    Started,
    Delta,
    ToolRead,
    RequiresApproval,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentStreamEvent {
    pub run_id: String,
    pub conversation_id: String,
    pub stage: OpsAgentStreamStage,
    pub chunk: Option<String>,
    pub full_answer: Option<String>,
    pub pending_action: Option<OpsAgentPendingAction>,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentListPendingActionsInput {
    pub session_id: Option<String>,
    pub only_pending: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentResolveActionInput {
    pub action_id: String,
    pub approve: bool,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentCancelRunInput {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentCancelRunResult {
    pub run_id: String,
    pub cancelled: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentResolveActionResult {
    pub action: OpsAgentPendingAction,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct PlannedToolAction {
    pub kind: OpsAgentToolKind,
    pub command: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PlannedAgentReply {
    pub reply: String,
    pub tool: PlannedToolAction,
}

impl OpsAgentConversationSummary {
    pub fn from_conversation(conversation: &OpsAgentConversation) -> Self {
        let last_message_preview = conversation.messages.last().map(|item| {
            let mut preview = item.content.trim().replace('\n', " ");
            if preview.chars().count() > 120 {
                preview = preview.chars().take(120).collect::<String>();
                preview.push_str("...");
            }
            preview
        });

        Self {
            id: conversation.id.clone(),
            title: conversation.title.clone(),
            session_id: conversation.session_id.clone(),
            message_count: conversation.messages.len(),
            last_message_preview,
            created_at: conversation.created_at.clone(),
            updated_at: conversation.updated_at.clone(),
        }
    }
}

impl OpsAgentStreamEvent {
    pub fn new(
        run_id: impl Into<String>,
        conversation_id: impl Into<String>,
        stage: OpsAgentStreamStage,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            conversation_id: conversation_id.into(),
            stage,
            chunk: None,
            full_answer: None,
            pending_action: None,
            error: None,
            created_at: now_rfc3339(),
        }
    }
}

impl OpsAgentShellContext {
    pub fn normalize(value: Option<Self>) -> Option<Self> {
        let value = value?;
        let content = normalize_shell_context_content(&value.content)?;
        let session_name = normalize_shell_context_session_name(&value.session_name);
        let preview = build_shell_context_preview(&content);
        let char_count = content.chars().count();

        Some(Self {
            session_id: normalize_optional_string(value.session_id),
            session_name,
            content,
            preview,
            char_count,
        })
    }
}

fn default_pending_action_tool_kind() -> OpsAgentToolKind {
    OpsAgentToolKind::shell()
}

fn default_shell_context_session_name() -> String {
    "Shell".to_string()
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn normalize_shell_context_session_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default_shell_context_session_name()
    } else {
        trimmed.to_string()
    }
}

fn normalize_shell_context_content(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut content = trimmed
        .chars()
        .take(SHELL_CONTEXT_MAX_CHARS)
        .collect::<String>();
    if trimmed.chars().count() > SHELL_CONTEXT_MAX_CHARS {
        content.push_str("...");
    }
    Some(content)
}

fn build_shell_context_preview(content: &str) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = compact
        .chars()
        .take(SHELL_CONTEXT_PREVIEW_CHARS)
        .collect::<String>();
    if compact.chars().count() > SHELL_CONTEXT_PREVIEW_CHARS {
        preview.push_str("...");
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_shell_context_payload() {
        let payload = OpsAgentShellContext::normalize(Some(OpsAgentShellContext {
            session_id: Some("  session-1 ".to_string()),
            session_name: " Prod ".to_string(),
            content: " line1\n\nline2\tvalue ".to_string(),
            preview: String::new(),
            char_count: 0,
        }))
        .expect("normalize shell context");

        assert_eq!(payload.session_id.as_deref(), Some("session-1"));
        assert_eq!(payload.session_name, "Prod");
        assert_eq!(payload.content, "line1\n\nline2\tvalue");
        assert_eq!(payload.preview, "line1 line2 value");
        assert_eq!(payload.char_count, payload.content.chars().count());
    }

    #[test]
    fn message_deserializes_without_shell_context_field() {
        let message = serde_json::from_value::<OpsAgentMessage>(json!({
            "id": "msg-1",
            "role": "user",
            "content": "legacy question",
            "createdAt": "2026-03-20T00:00:00Z"
        }))
        .expect("deserialize legacy message");

        assert!(message.tool_kind.is_none());
        assert!(message.shell_context.is_none());
    }

    #[test]
    fn pending_action_defaults_risk_level_for_legacy_payloads() {
        let action = serde_json::from_value::<OpsAgentPendingAction>(json!({
            "id": "action-1",
            "toolKind": "write_shell",
            "conversationId": "conv-1",
            "sessionId": "session-1",
            "command": "systemctl restart nginx",
            "reason": "restart service",
            "status": "pending",
            "createdAt": "2026-03-20T00:00:00Z",
            "updatedAt": "2026-03-20T00:00:00Z",
            "resolvedAt": null,
            "executionOutput": null,
            "executionExitCode": null
        }))
        .expect("deserialize legacy pending action");

        assert_eq!(action.risk_level, OpsAgentRiskLevel::Low);
    }
}
