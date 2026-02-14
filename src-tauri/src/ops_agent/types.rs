use serde::{Deserialize, Serialize};

use crate::models::now_rfc3339;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpsAgentRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsAgentToolKind {
    None,
    ReadShell,
    WriteShell,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsAgentActionStatus {
    Pending,
    Rejected,
    Executed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentMessage {
    pub id: String,
    pub role: OpsAgentRole,
    pub content: String,
    pub created_at: String,
    pub tool_kind: Option<OpsAgentToolKind>,
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
    pub conversation_id: String,
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
