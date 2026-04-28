use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::ops_agent::infrastructure::logging::{
    append_debug_log_at_path, resolve_ops_agent_log_path, truncate_for_log,
};

use crate::ops_agent::domain::types::{
    OpsAgentActionStatus, OpsAgentApprovalDecision, OpsAgentConversation,
    OpsAgentConversationSummary, OpsAgentData, OpsAgentExecutorResumeContext, OpsAgentMessage,
    OpsAgentPendingAction, OpsAgentRiskLevel, OpsAgentRole, OpsAgentShellContext, OpsAgentToolKind,
};

const LEGACY_DATA_FILE: &str = "ops_agent.json";
const CONVERSATION_LIST_FILE: &str = "ops_agent_conversation_list.json";
const CONVERSATIONS_DIR: &str = "ops_agent_conversations";
const DEFAULT_CONVERSATION_TITLE: &str = "New Conversation";
const AUTO_TITLE_MAX_CHARS: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OpsAgentConversationListData {
    conversations: Vec<OpsAgentConversationSummary>,
    active_conversation_id: Option<String>,
    pending_actions: Vec<OpsAgentPendingAction>,
}

impl OpsAgentConversationListData {
    fn from_data(data: &OpsAgentData) -> Self {
        Self {
            conversations: data
                .conversations
                .iter()
                .map(OpsAgentConversationSummary::from_conversation)
                .collect(),
            active_conversation_id: data.active_conversation_id.clone(),
            pending_actions: data.pending_actions.clone(),
        }
    }
}

pub struct OpsAgentStore {
    log_path: PathBuf,
    list_path: PathBuf,
    conversations_dir: PathBuf,
    data: RwLock<OpsAgentData>,
}

impl OpsAgentStore {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        let log_path = resolve_ops_agent_log_path(&root);
        fs::create_dir_all(&root)?;
        let legacy_path = root.join(LEGACY_DATA_FILE);

        let list_path = root.join(CONVERSATION_LIST_FILE);
        let conversations_dir = root.join(CONVERSATIONS_DIR);
        fs::create_dir_all(&conversations_dir)?;

        let mut data = load_ops_agent_data(&list_path, &conversations_dir, &legacy_path)?;
        normalize_data(&mut data);

        let store = Self {
            log_path,
            list_path,
            conversations_dir,
            data: RwLock::new(data),
        };

        {
            let guard = store.data.read().expect("ops agent lock poisoned");
            store.persist_all_locked(&guard)?;
        }
        remove_file_if_exists(&legacy_path)?;
        store.log(
            "infrastructure.store.initialized",
            None,
            None,
            format!(
                "conversations={} pending_actions={} active_conversation_id={}",
                store
                    .data
                    .read()
                    .expect("ops agent lock poisoned")
                    .conversations
                    .len(),
                store
                    .data
                    .read()
                    .expect("ops agent lock poisoned")
                    .pending_actions
                    .len(),
                store
                    .data
                    .read()
                    .expect("ops agent lock poisoned")
                    .active_conversation_id
                    .as_deref()
                    .unwrap_or("-")
            ),
        );

        Ok(store)
    }

    pub fn list_conversation_summaries(&self) -> Vec<OpsAgentConversationSummary> {
        let guard = self.data.read().expect("ops agent lock poisoned");
        let mut rows = guard
            .conversations
            .iter()
            .map(OpsAgentConversationSummary::from_conversation)
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        rows
    }

    pub fn get_conversation(&self, id: &str) -> AppResult<OpsAgentConversation> {
        self.data
            .read()
            .expect("ops agent lock poisoned")
            .conversations
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("ops agent conversation {id}")))
    }

    pub fn ensure_conversation(
        &self,
        conversation_id: Option<&str>,
        _title_hint: &str,
        session_id: Option<&str>,
    ) -> AppResult<OpsAgentConversation> {
        let normalized_session_id = normalize_session_id(session_id);
        if let Some(id) = conversation_id {
            let mut guard = self.data.write().expect("ops agent lock poisoned");
            let index = guard
                .conversations
                .iter()
                .position(|item| item.id == id)
                .ok_or_else(|| AppError::NotFound(format!("ops agent conversation {id}")))?;

            let mut should_persist_conversation = false;
            if normalized_session_id.is_some()
                && guard.conversations[index].session_id != normalized_session_id
            {
                guard.conversations[index].session_id = normalized_session_id.clone();
                guard.conversations[index].updated_at = now_rfc3339();
                should_persist_conversation = true;
            }

            guard.active_conversation_id = Some(id.to_string());
            let snapshot = guard.conversations[index].clone();

            if should_persist_conversation {
                self.persist_conversation_locked(&snapshot)?;
            }
            self.persist_list_locked(&guard)?;
            self.log(
                "infrastructure.store.ensure_conversation_existing",
                None,
                Some(id),
                format!(
                    "session_id={} rebound={} message_count={}",
                    snapshot.session_id.as_deref().unwrap_or("-"),
                    should_persist_conversation,
                    snapshot.messages.len()
                ),
            );
            return Ok(snapshot);
        }

        self.create_conversation(None, normalized_session_id.as_deref())
    }

    pub fn create_conversation(
        &self,
        title: Option<&str>,
        session_id: Option<&str>,
    ) -> AppResult<OpsAgentConversation> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let now = now_rfc3339();
        let conversation = OpsAgentConversation {
            id: Uuid::new_v4().to_string(),
            title: derive_conversation_title(title),
            session_id: normalize_session_id(session_id),
            messages: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };

        guard.active_conversation_id = Some(conversation.id.clone());
        guard.conversations.push(conversation.clone());

        self.persist_conversation_locked(&conversation)?;
        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.conversation_created",
            None,
            Some(conversation.id.as_str()),
            format!(
                "title={} session_id={}",
                truncate_for_log(conversation.title.as_str(), 80),
                conversation.session_id.as_deref().unwrap_or("-")
            ),
        );
        Ok(conversation)
    }

    pub fn set_active_conversation(&self, id: &str) -> AppResult<()> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        if !guard.conversations.iter().any(|item| item.id == id) {
            return Err(AppError::NotFound(format!("ops agent conversation {id}")));
        }
        guard.active_conversation_id = Some(id.to_string());
        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.active_conversation_set",
            None,
            Some(id),
            "active conversation updated",
        );
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> AppResult<()> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let before = guard.conversations.len();
        guard.conversations.retain(|item| item.id != id);
        if guard.conversations.len() == before {
            return Err(AppError::NotFound(format!("ops agent conversation {id}")));
        }

        guard
            .pending_actions
            .retain(|item| item.conversation_id != id);
        let active_valid = guard
            .active_conversation_id
            .as_ref()
            .map(|value| guard.conversations.iter().any(|item| item.id == *value))
            .unwrap_or(false);
        if !active_valid {
            guard.active_conversation_id = guard.conversations.first().map(|item| item.id.clone());
        }

        remove_file_if_exists(&self.conversation_path(id))?;
        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.conversation_deleted",
            None,
            Some(id),
            format!(
                "remaining_conversations={} remaining_pending_actions={}",
                guard.conversations.len(),
                guard.pending_actions.len()
            ),
        );
        Ok(())
    }

    pub fn append_message(
        &self,
        conversation_id: &str,
        role: OpsAgentRole,
        content: &str,
        tool_kind: Option<OpsAgentToolKind>,
        shell_context: Option<OpsAgentShellContext>,
        attachment_ids: Vec<String>,
    ) -> AppResult<OpsAgentMessage> {
        let trimmed = content.trim();
        let attachment_ids = normalize_attachment_ids(attachment_ids);
        if trimmed.is_empty() && attachment_ids.is_empty() {
            return Err(AppError::Validation(
                "message content cannot be empty unless image attachments are present".to_string(),
            ));
        }

        let shell_context = if role == OpsAgentRole::User {
            OpsAgentShellContext::normalize(shell_context)
        } else {
            None
        };

        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let (message, snapshot) = {
            let conversation = guard
                .conversations
                .iter_mut()
                .find(|item| item.id == conversation_id)
                .ok_or_else(|| {
                    AppError::NotFound(format!("ops agent conversation {conversation_id}"))
                })?;

            let should_auto_title = matches!(role, OpsAgentRole::User)
                && should_auto_rename_title(&conversation.title)
                && !conversation
                    .messages
                    .iter()
                    .any(|item| item.role == OpsAgentRole::User);

            let message = OpsAgentMessage {
                id: Uuid::new_v4().to_string(),
                role,
                content: trimmed.to_string(),
                created_at: now_rfc3339(),
                tool_kind,
                shell_context,
                attachment_ids,
            };

            conversation.messages.push(message.clone());
            if should_auto_title {
                conversation.title = derive_title_from_first_user_prompt(
                    derive_title_seed(message.content.as_str(), message.attachment_ids.len())
                        .as_str(),
                );
            }
            conversation.updated_at = now_rfc3339();
            (message, conversation.clone())
        };

        guard.active_conversation_id = Some(conversation_id.to_string());
        self.persist_conversation_locked(&snapshot)?;
        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.message_appended",
            None,
            Some(conversation_id),
            format!(
                "message_id={} role={:?} chars={} tool_kind={} shell_context={} attachment_count={}",
                message.id,
                message.role,
                message.content.chars().count(),
                message
                    .tool_kind
                    .as_ref()
                    .map(|item| item.as_str())
                    .unwrap_or("-"),
                message.shell_context.is_some(),
                message.attachment_ids.len()
            ),
        );
        Ok(message)
    }

    pub fn replace_messages(
        &self,
        conversation_id: &str,
        messages: Vec<OpsAgentMessage>,
    ) -> AppResult<OpsAgentConversation> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let conversation = guard
            .conversations
            .iter_mut()
            .find(|item| item.id == conversation_id)
            .ok_or_else(|| {
                AppError::NotFound(format!("ops agent conversation {conversation_id}"))
            })?;

        conversation.messages = messages;
        conversation.updated_at = now_rfc3339();
        let snapshot = conversation.clone();

        guard.active_conversation_id = Some(conversation_id.to_string());
        self.persist_conversation_locked(&snapshot)?;
        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.messages_replaced",
            None,
            Some(conversation_id),
            format!("message_count={}", snapshot.messages.len()),
        );
        Ok(snapshot)
    }

    pub fn list_pending_actions(
        &self,
        session_id: Option<&str>,
        only_pending: bool,
    ) -> Vec<OpsAgentPendingAction> {
        let guard = self.data.read().expect("ops agent lock poisoned");
        guard
            .pending_actions
            .iter()
            .filter(|item| {
                let session_match = session_id
                    .map(|session| item.session_id.as_deref() == Some(session))
                    .unwrap_or(true);
                let status_match = if only_pending {
                    item.status == OpsAgentActionStatus::Pending
                } else {
                    true
                };
                session_match && status_match
            })
            .cloned()
            .collect()
    }

    pub fn create_pending_action(
        &self,
        conversation_id: &str,
        source_user_message_id: Option<&str>,
        session_id: Option<&str>,
        tool_kind: OpsAgentToolKind,
        risk_level: OpsAgentRiskLevel,
        command: &str,
        reason: &str,
    ) -> AppResult<OpsAgentPendingAction> {
        if command.trim().is_empty() {
            return Err(AppError::Validation(
                "tool command cannot be empty".to_string(),
            ));
        }

        let mut guard = self.data.write().expect("ops agent lock poisoned");
        if !guard
            .conversations
            .iter()
            .any(|item| item.id == conversation_id)
        {
            return Err(AppError::NotFound(format!(
                "ops agent conversation {conversation_id}"
            )));
        }

        let now = now_rfc3339();
        let action = OpsAgentPendingAction {
            id: Uuid::new_v4().to_string(),
            tool_kind,
            risk_level,
            conversation_id: conversation_id.to_string(),
            source_user_message_id: source_user_message_id.and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }),
            session_id: session_id.map(|item| item.to_string()),
            command: command.trim().to_string(),
            reason: reason.trim().to_string(),
            status: OpsAgentActionStatus::Pending,
            created_at: now.clone(),
            updated_at: now,
            resolved_at: None,
            approval_decision: None,
            approval_comment: None,
            approval_at: None,
            execution_output: None,
            execution_exit_code: None,
            resume_context: None,
        };
        guard.pending_actions.push(action.clone());

        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.pending_action_created",
            None,
            Some(conversation_id),
            format!(
                "action_id={} tool={} risk={} session_id={} command={} reason={}",
                action.id,
                action.tool_kind,
                risk_level_label(&action.risk_level),
                action.session_id.as_deref().unwrap_or("-"),
                truncate_for_log(action.command.as_str(), 160),
                truncate_for_log(action.reason.as_str(), 160),
            ),
        );
        Ok(action)
    }

    pub fn get_pending_action(&self, action_id: &str) -> AppResult<OpsAgentPendingAction> {
        self.data
            .read()
            .expect("ops agent lock poisoned")
            .pending_actions
            .iter()
            .find(|item| item.id == action_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("ops agent action {action_id}")))
    }

    pub fn set_action_resume_context(
        &self,
        action_id: &str,
        resume_context: OpsAgentExecutorResumeContext,
    ) -> AppResult<OpsAgentPendingAction> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let action_index = guard
            .pending_actions
            .iter_mut()
            .position(|item| item.id == action_id)
            .ok_or_else(|| AppError::NotFound(format!("ops agent action {action_id}")))?;

        let now = now_rfc3339();
        let snapshot = {
            let action = &mut guard.pending_actions[action_index];
            action.resume_context = Some(resume_context);
            action.updated_at = now;
            action.clone()
        };

        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.pending_action_resume_context_set",
            None,
            Some(snapshot.conversation_id.as_str()),
            format!(
                "action_id={} pending_step_id={} execution_steps={}",
                snapshot.id,
                snapshot
                    .resume_context
                    .as_ref()
                    .map(|item| item.pending_step_id.as_str())
                    .unwrap_or("-"),
                snapshot
                    .resume_context
                    .as_ref()
                    .map(|item| item.execution_steps.len())
                    .unwrap_or(0),
            ),
        );
        Ok(snapshot)
    }

    pub fn mark_action_rejected(
        &self,
        action_id: &str,
        approval_comment: Option<String>,
    ) -> AppResult<OpsAgentPendingAction> {
        self.update_action_status(
            action_id,
            OpsAgentActionStatus::Rejected,
            Some(OpsAgentApprovalDecision::Rejected),
            approval_comment,
            None,
            None,
        )
    }

    pub fn mark_action_executed(
        &self,
        action_id: &str,
        output: String,
        exit_code: i32,
        approval_comment: Option<String>,
    ) -> AppResult<OpsAgentPendingAction> {
        self.update_action_status(
            action_id,
            OpsAgentActionStatus::Executed,
            Some(OpsAgentApprovalDecision::Approved),
            approval_comment,
            Some(output),
            Some(exit_code),
        )
    }

    pub fn mark_action_failed(
        &self,
        action_id: &str,
        output: String,
        approval_comment: Option<String>,
    ) -> AppResult<OpsAgentPendingAction> {
        self.update_action_status(
            action_id,
            OpsAgentActionStatus::Failed,
            Some(OpsAgentApprovalDecision::Approved),
            approval_comment,
            Some(output),
            None,
        )
    }

    fn update_action_status(
        &self,
        action_id: &str,
        status: OpsAgentActionStatus,
        approval_decision: Option<OpsAgentApprovalDecision>,
        approval_comment: Option<String>,
        output: Option<String>,
        exit_code: Option<i32>,
    ) -> AppResult<OpsAgentPendingAction> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let action_index = guard
            .pending_actions
            .iter_mut()
            .position(|item| item.id == action_id)
            .ok_or_else(|| AppError::NotFound(format!("ops agent action {action_id}")))?;

        let now = now_rfc3339();
        let (conversation_id, snapshot) = {
            let action = &mut guard.pending_actions[action_index];
            action.status = status;
            action.updated_at = now.clone();
            action.resolved_at = Some(now.clone());
            if let Some(decision) = approval_decision {
                action.approval_decision = Some(decision);
                action.approval_at = Some(now.clone());
            }
            action.approval_comment = approval_comment;
            action.execution_output = output;
            action.execution_exit_code = exit_code;
            (action.conversation_id.clone(), action.clone())
        };

        let mut updated_conversation = None;
        if let Some(conversation) = guard
            .conversations
            .iter_mut()
            .find(|item| item.id == conversation_id)
        {
            conversation.updated_at = now_rfc3339();
            updated_conversation = Some(conversation.clone());
        }

        if let Some(conversation) = updated_conversation {
            self.persist_conversation_locked(&conversation)?;
        }
        self.persist_list_locked(&guard)?;
        self.log(
            "infrastructure.store.pending_action_updated",
            None,
            Some(snapshot.conversation_id.as_str()),
            format!(
                "action_id={} status={:?} approval_decision={} exit_code={} output_chars={}",
                snapshot.id,
                snapshot.status,
                snapshot
                    .approval_decision
                    .as_ref()
                    .map(approval_decision_label)
                    .unwrap_or("-"),
                snapshot
                    .execution_exit_code
                    .map(|item| item.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                snapshot
                    .execution_output
                    .as_ref()
                    .map(|item| item.chars().count())
                    .unwrap_or(0),
            ),
        );
        Ok(snapshot)
    }

    fn persist_conversation_locked(&self, conversation: &OpsAgentConversation) -> AppResult<()> {
        write_json_pretty(&self.conversation_path(&conversation.id), conversation)
    }

    fn persist_list_locked(&self, data: &OpsAgentData) -> AppResult<()> {
        write_json_pretty(
            &self.list_path,
            &OpsAgentConversationListData::from_data(data),
        )
    }

    fn persist_all_locked(&self, data: &OpsAgentData) -> AppResult<()> {
        for conversation in &data.conversations {
            self.persist_conversation_locked(conversation)?;
        }
        self.cleanup_orphaned_conversation_files(data)?;
        self.persist_list_locked(data)
    }

    fn cleanup_orphaned_conversation_files(&self, data: &OpsAgentData) -> AppResult<()> {
        if !self.conversations_dir.exists() {
            return Ok(());
        }

        let valid_ids = data
            .conversations
            .iter()
            .map(|item| item.id.clone())
            .collect::<HashSet<_>>();

        for entry in fs::read_dir(&self.conversations_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !is_json_file(&path) {
                continue;
            }

            let file_id = match path.file_stem().and_then(|item| item.to_str()) {
                Some(value) => value,
                None => continue,
            };

            if !valid_ids.contains(file_id) {
                remove_file_if_exists(&path)?;
            }
        }

        Ok(())
    }

    fn conversation_path(&self, conversation_id: &str) -> PathBuf {
        self.conversations_dir
            .join(format!("{conversation_id}.json"))
    }

    fn log(
        &self,
        level: &str,
        run_id: Option<&str>,
        conversation_id: Option<&str>,
        message: impl AsRef<str>,
    ) {
        append_debug_log_at_path(&self.log_path, level, run_id, conversation_id, message);
    }
}

fn derive_conversation_title(title: Option<&str>) -> String {
    let source = title.unwrap_or("").trim();
    if source.is_empty() {
        return DEFAULT_CONVERSATION_TITLE.to_string();
    }

    let compact = source.replace('\n', " ");
    let mut out = compact.chars().take(24).collect::<String>();
    if compact.chars().count() > 24 {
        out.push_str("...");
    }
    out
}

fn normalize_session_id(session_id: Option<&str>) -> Option<String> {
    let session_id = session_id?;
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_attachment_ids(attachment_ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for attachment_id in attachment_ids {
        let trimmed = attachment_id.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

fn approval_decision_label(value: &OpsAgentApprovalDecision) -> &'static str {
    match value {
        OpsAgentApprovalDecision::Approved => "approved",
        OpsAgentApprovalDecision::Rejected => "rejected",
    }
}

fn risk_level_label(value: &OpsAgentRiskLevel) -> &'static str {
    match value {
        OpsAgentRiskLevel::Low => "low",
        OpsAgentRiskLevel::Medium => "medium",
        OpsAgentRiskLevel::High => "high",
    }
}

fn should_auto_rename_title(current_title: &str) -> bool {
    let normalized = current_title.trim();
    normalized.is_empty() || normalized == DEFAULT_CONVERSATION_TITLE
}

fn derive_title_from_first_user_prompt(prompt: &str) -> String {
    let compact = prompt
        .replace('\r', " ")
        .replace('\n', " ")
        .trim()
        .to_string();

    if compact.is_empty() {
        return DEFAULT_CONVERSATION_TITLE.to_string();
    }

    let mut out = compact
        .chars()
        .take(AUTO_TITLE_MAX_CHARS)
        .collect::<String>();
    if compact.chars().count() > AUTO_TITLE_MAX_CHARS {
        out.push_str("...");
    }
    out
}

fn derive_title_seed(content: &str, attachment_count: usize) -> String {
    let trimmed = content.trim();
    if !trimmed.is_empty() {
        trimmed.to_string()
    } else if attachment_count == 1 {
        "Image upload".to_string()
    } else if attachment_count > 1 {
        format!("{attachment_count} image upload")
    } else {
        DEFAULT_CONVERSATION_TITLE.to_string()
    }
}

fn normalize_data(data: &mut OpsAgentData) {
    data.conversations
        .sort_by(|left, right| left.created_at.cmp(&right.created_at));

    let active_valid = data
        .active_conversation_id
        .as_ref()
        .map(|id| data.conversations.iter().any(|item| item.id == *id))
        .unwrap_or(false);
    if !active_valid {
        data.active_conversation_id = data.conversations.first().map(|item| item.id.clone());
    }
}

fn load_ops_agent_data(
    list_path: &Path,
    conversations_dir: &Path,
    legacy_path: &Path,
) -> AppResult<OpsAgentData> {
    if list_path.exists() {
        let list_data = read_json_or_default::<OpsAgentConversationListData>(list_path)?;
        let conversations =
            load_conversations_with_preferred_order(conversations_dir, &list_data.conversations)?;

        return Ok(OpsAgentData {
            conversations,
            active_conversation_id: list_data.active_conversation_id,
            pending_actions: list_data.pending_actions,
        });
    }

    let detached_conversations = read_all_conversation_files(conversations_dir)?;
    if !detached_conversations.is_empty() {
        return Ok(OpsAgentData {
            conversations: detached_conversations,
            active_conversation_id: None,
            pending_actions: Vec::new(),
        });
    }

    read_json_or_default::<OpsAgentData>(legacy_path)
}

fn load_conversations_with_preferred_order(
    conversations_dir: &Path,
    preferred: &[OpsAgentConversationSummary],
) -> AppResult<Vec<OpsAgentConversation>> {
    let conversations = read_all_conversation_files(conversations_dir)?;
    if preferred.is_empty() {
        return Ok(conversations);
    }

    let mut by_id = conversations
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();

    let mut ordered = Vec::new();
    for summary in preferred {
        if let Some(conversation) = by_id.remove(&summary.id) {
            ordered.push(conversation);
        }
    }

    let mut remaining = by_id.into_values().collect::<Vec<_>>();
    remaining.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    ordered.extend(remaining);
    Ok(ordered)
}

fn read_all_conversation_files(conversations_dir: &Path) -> AppResult<Vec<OpsAgentConversation>> {
    if !conversations_dir.exists() {
        return Ok(Vec::new());
    }

    let mut rows = Vec::new();
    for entry in fs::read_dir(conversations_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !is_json_file(&path) {
            continue;
        }

        let row = read_json::<OpsAgentConversation>(&path)?;
        if !row.id.trim().is_empty() {
            rows.push(row);
        }
    }

    rows.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(rows)
}

fn is_json_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|item| item.to_str())
            .map(|item| item.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
}

fn remove_file_if_exists(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path)?;
    Ok(())
}

fn read_json_or_default<T>(path: &Path) -> AppResult<T>
where
    T: serde::de::DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let content = fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(T::default());
    }
    Ok(serde_json::from_str(&content)?)
}

fn read_json<T>(path: &Path) -> AppResult<T>
where
    T: serde::de::DeserializeOwned,
{
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn write_json_pretty<T>(path: &Path, value: &T) -> AppResult<()>
where
    T: serde::Serialize,
{
    let text = serde_json::to_string_pretty(value)?;
    fs::write(path, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        env::temp_dir().join(format!("eshell-ops-agent-{name}-{stamp}"))
    }

    #[test]
    fn conversation_and_action_crud_works() {
        let store = OpsAgentStore::new(temp_dir("crud")).expect("create store");
        let conversation = store
            .create_conversation(Some("CPU analysis"), Some("session-1"))
            .expect("create conversation");
        assert_eq!(store.list_conversation_summaries().len(), 1);

        store
            .append_message(
                &conversation.id,
                OpsAgentRole::User,
                "check cpu",
                None,
                None,
                Vec::new(),
            )
            .expect("append user");
        store
            .append_message(
                &conversation.id,
                OpsAgentRole::Assistant,
                "running read_shell",
                Some(OpsAgentToolKind::read_shell()),
                None,
                Vec::new(),
            )
            .expect("append assistant");

        let action = store
            .create_pending_action(
                &conversation.id,
                None,
                Some("session-1"),
                OpsAgentToolKind::write_shell(),
                OpsAgentRiskLevel::High,
                "reboot",
                "danger",
            )
            .expect("create action");
        assert_eq!(action.status, OpsAgentActionStatus::Pending);
        assert_eq!(action.tool_kind, OpsAgentToolKind::write_shell());
        assert_eq!(action.risk_level, OpsAgentRiskLevel::High);
        assert!(action.source_user_message_id.is_none());
        assert_eq!(store.list_pending_actions(Some("session-1"), true).len(), 1);

        let rejected = store
            .mark_action_rejected(&action.id, Some("operator rejected".to_string()))
            .expect("reject");
        assert_eq!(rejected.status, OpsAgentActionStatus::Rejected);
        assert_eq!(
            rejected.approval_decision,
            Some(OpsAgentApprovalDecision::Rejected)
        );
        assert_eq!(
            rejected.approval_comment.as_deref(),
            Some("operator rejected")
        );
    }

    #[test]
    fn first_user_message_derives_short_title() {
        let store = OpsAgentStore::new(temp_dir("title")).expect("create store");
        let conversation = store
            .create_conversation(None, Some("session-1"))
            .expect("create conversation");

        store
            .append_message(
                &conversation.id,
                OpsAgentRole::User,
                "abcdefghijklmnopqrstuvwxyz",
                None,
                None,
                Vec::new(),
            )
            .expect("append user");

        let loaded = store
            .get_conversation(&conversation.id)
            .expect("load conversation");
        assert_eq!(loaded.title, "abcdefghij...");
    }

    #[test]
    fn shell_context_is_persisted_with_user_message() {
        let store = OpsAgentStore::new(temp_dir("shell-context")).expect("create store");
        let conversation = store
            .create_conversation(Some("Shell Context"), Some("session-1"))
            .expect("create conversation");

        store
            .append_message(
                &conversation.id,
                OpsAgentRole::User,
                "What changed here?",
                None,
                Some(OpsAgentShellContext {
                    session_id: Some("session-1".to_string()),
                    session_name: "Prod".to_string(),
                    content: "systemctl status nginx".to_string(),
                    preview: String::new(),
                    char_count: 0,
                }),
                Vec::new(),
            )
            .expect("append user");

        let loaded = store
            .get_conversation(&conversation.id)
            .expect("load conversation");
        let shell_context = loaded.messages[0]
            .shell_context
            .as_ref()
            .expect("shell context");

        assert_eq!(shell_context.session_id.as_deref(), Some("session-1"));
        assert_eq!(shell_context.session_name, "Prod");
        assert_eq!(shell_context.content, "systemctl status nginx");
        assert_eq!(shell_context.preview, "systemctl status nginx");
    }

    #[test]
    fn split_storage_files_are_written() {
        let root = temp_dir("split-files");
        let store = OpsAgentStore::new(root.clone()).expect("create store");
        let conversation = store
            .create_conversation(None, Some("session-1"))
            .expect("create conversation");

        assert!(root.join(CONVERSATION_LIST_FILE).exists());
        assert!(root
            .join(CONVERSATIONS_DIR)
            .join(format!("{}.json", conversation.id))
            .exists());
    }

    #[test]
    fn migrates_legacy_single_file_to_split_layout() {
        let root = temp_dir("legacy-migration");
        fs::create_dir_all(&root).expect("create root");

        let now = now_rfc3339();
        let conversation = OpsAgentConversation {
            id: "legacy-conv-1".to_string(),
            title: "Legacy Title".to_string(),
            session_id: Some("session-legacy".to_string()),
            messages: vec![OpsAgentMessage {
                id: "legacy-msg-1".to_string(),
                role: OpsAgentRole::User,
                content: "legacy question".to_string(),
                created_at: now.clone(),
                tool_kind: None,
                shell_context: None,
                attachment_ids: Vec::new(),
            }],
            created_at: now.clone(),
            updated_at: now,
        };

        let legacy_data = OpsAgentData {
            conversations: vec![conversation.clone()],
            active_conversation_id: Some(conversation.id.clone()),
            pending_actions: Vec::new(),
        };

        write_json_pretty(&root.join(LEGACY_DATA_FILE), &legacy_data).expect("write legacy file");

        let store = OpsAgentStore::new(root.clone()).expect("create store from legacy");
        assert_eq!(store.list_conversation_summaries().len(), 1);
        assert!(root.join(CONVERSATION_LIST_FILE).exists());
        assert!(root
            .join(CONVERSATIONS_DIR)
            .join("legacy-conv-1.json")
            .exists());
    }

    #[test]
    fn ensure_conversation_rebinds_session_when_request_uses_new_session() {
        let store = OpsAgentStore::new(temp_dir("session-rebind")).expect("create store");
        let conversation = store
            .create_conversation(Some("Session Rebind"), Some("session-1"))
            .expect("create conversation");

        let rebound = store
            .ensure_conversation(Some(&conversation.id), "ignored", Some("session-2"))
            .expect("rebind session");

        assert_eq!(rebound.session_id.as_deref(), Some("session-2"));
        let loaded = store
            .get_conversation(&conversation.id)
            .expect("reload conversation");
        assert_eq!(loaded.session_id.as_deref(), Some("session-2"));
    }
}
