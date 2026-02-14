use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;

use super::types::{
    OpsAgentActionStatus, OpsAgentConversation, OpsAgentConversationSummary, OpsAgentData,
    OpsAgentMessage, OpsAgentPendingAction, OpsAgentRole, OpsAgentToolKind,
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
    list_path: PathBuf,
    conversations_dir: PathBuf,
    data: RwLock<OpsAgentData>,
}

impl OpsAgentStore {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&root)?;
        let legacy_path = root.join(LEGACY_DATA_FILE);

        let list_path = root.join(CONVERSATION_LIST_FILE);
        let conversations_dir = root.join(CONVERSATIONS_DIR);
        fs::create_dir_all(&conversations_dir)?;

        let mut data = load_ops_agent_data(&list_path, &conversations_dir, &legacy_path)?;
        normalize_data(&mut data);

        let store = Self {
            list_path,
            conversations_dir,
            data: RwLock::new(data),
        };

        {
            let guard = store.data.read().expect("ops agent lock poisoned");
            store.persist_all_locked(&guard)?;
        }
        remove_file_if_exists(&legacy_path)?;

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
        if let Some(id) = conversation_id {
            let mut guard = self.data.write().expect("ops agent lock poisoned");
            let index = guard
                .conversations
                .iter()
                .position(|item| item.id == id)
                .ok_or_else(|| AppError::NotFound(format!("ops agent conversation {id}")))?;

            let mut should_persist_conversation = false;
            if guard.conversations[index].session_id.is_none() {
                guard.conversations[index].session_id = session_id.map(|item| item.to_string());
                guard.conversations[index].updated_at = now_rfc3339();
                should_persist_conversation = true;
            }

            guard.active_conversation_id = Some(id.to_string());
            let snapshot = guard.conversations[index].clone();

            if should_persist_conversation {
                self.persist_conversation_locked(&snapshot)?;
            }
            self.persist_list_locked(&guard)?;
            return Ok(snapshot);
        }

        self.create_conversation(None, session_id)
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
            session_id: session_id.map(|item| item.to_string()),
            messages: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };

        guard.active_conversation_id = Some(conversation.id.clone());
        guard.conversations.push(conversation.clone());

        self.persist_conversation_locked(&conversation)?;
        self.persist_list_locked(&guard)?;
        Ok(conversation)
    }

    pub fn set_active_conversation(&self, id: &str) -> AppResult<()> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        if !guard.conversations.iter().any(|item| item.id == id) {
            return Err(AppError::NotFound(format!("ops agent conversation {id}")));
        }
        guard.active_conversation_id = Some(id.to_string());
        self.persist_list_locked(&guard)
    }

    pub fn delete_conversation(&self, id: &str) -> AppResult<()> {
        let mut guard = self.data.write().expect("ops agent lock poisoned");
        let before = guard.conversations.len();
        guard.conversations.retain(|item| item.id != id);
        if guard.conversations.len() == before {
            return Err(AppError::NotFound(format!("ops agent conversation {id}")));
        }

        guard.pending_actions.retain(|item| item.conversation_id != id);
        let active_valid = guard
            .active_conversation_id
            .as_ref()
            .map(|value| guard.conversations.iter().any(|item| item.id == *value))
            .unwrap_or(false);
        if !active_valid {
            guard.active_conversation_id = guard.conversations.first().map(|item| item.id.clone());
        }

        remove_file_if_exists(&self.conversation_path(id))?;
        self.persist_list_locked(&guard)
    }

    pub fn append_message(
        &self,
        conversation_id: &str,
        role: OpsAgentRole,
        content: &str,
        tool_kind: Option<OpsAgentToolKind>,
    ) -> AppResult<OpsAgentMessage> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation("message content cannot be empty".to_string()));
        }

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
            };

            conversation.messages.push(message.clone());
            if should_auto_title {
                conversation.title = derive_title_from_first_user_prompt(trimmed);
            }
            conversation.updated_at = now_rfc3339();
            (message, conversation.clone())
        };

        guard.active_conversation_id = Some(conversation_id.to_string());
        self.persist_conversation_locked(&snapshot)?;
        self.persist_list_locked(&guard)?;
        Ok(message)
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
        session_id: Option<&str>,
        command: &str,
        reason: &str,
    ) -> AppResult<OpsAgentPendingAction> {
        if command.trim().is_empty() {
            return Err(AppError::Validation("tool command cannot be empty".to_string()));
        }

        let mut guard = self.data.write().expect("ops agent lock poisoned");
        if !guard.conversations.iter().any(|item| item.id == conversation_id) {
            return Err(AppError::NotFound(format!(
                "ops agent conversation {conversation_id}"
            )));
        }

        let now = now_rfc3339();
        let action = OpsAgentPendingAction {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            session_id: session_id.map(|item| item.to_string()),
            command: command.trim().to_string(),
            reason: reason.trim().to_string(),
            status: OpsAgentActionStatus::Pending,
            created_at: now.clone(),
            updated_at: now,
            resolved_at: None,
            execution_output: None,
            execution_exit_code: None,
        };
        guard.pending_actions.push(action.clone());

        self.persist_list_locked(&guard)?;
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

    pub fn mark_action_rejected(&self, action_id: &str) -> AppResult<OpsAgentPendingAction> {
        self.update_action_status(action_id, OpsAgentActionStatus::Rejected, None, None)
    }

    pub fn mark_action_executed(
        &self,
        action_id: &str,
        output: String,
        exit_code: i32,
    ) -> AppResult<OpsAgentPendingAction> {
        self.update_action_status(
            action_id,
            OpsAgentActionStatus::Executed,
            Some(output),
            Some(exit_code),
        )
    }

    pub fn mark_action_failed(
        &self,
        action_id: &str,
        output: String,
    ) -> AppResult<OpsAgentPendingAction> {
        self.update_action_status(action_id, OpsAgentActionStatus::Failed, Some(output), None)
    }

    fn update_action_status(
        &self,
        action_id: &str,
        status: OpsAgentActionStatus,
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
        Ok(snapshot)
    }

    fn persist_conversation_locked(&self, conversation: &OpsAgentConversation) -> AppResult<()> {
        write_json_pretty(&self.conversation_path(&conversation.id), conversation)
    }

    fn persist_list_locked(&self, data: &OpsAgentData) -> AppResult<()> {
        write_json_pretty(&self.list_path, &OpsAgentConversationListData::from_data(data))
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
        self.conversations_dir.join(format!("{conversation_id}.json"))
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
        let conversations = load_conversations_with_preferred_order(
            conversations_dir,
            &list_data.conversations,
        )?;

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
            .append_message(&conversation.id, OpsAgentRole::User, "check cpu", None)
            .expect("append user");
        store
            .append_message(
                &conversation.id,
                OpsAgentRole::Assistant,
                "running read_shell",
                Some(OpsAgentToolKind::ReadShell),
            )
            .expect("append assistant");

        let action = store
            .create_pending_action(&conversation.id, Some("session-1"), "reboot", "danger")
            .expect("create action");
        assert_eq!(action.status, OpsAgentActionStatus::Pending);
        assert_eq!(store.list_pending_actions(Some("session-1"), true).len(), 1);

        let rejected = store.mark_action_rejected(&action.id).expect("reject");
        assert_eq!(rejected.status, OpsAgentActionStatus::Rejected);
    }

    #[test]
    fn first_user_message_derives_short_title() {
        let store = OpsAgentStore::new(temp_dir("title")).expect("create store");
        let conversation = store
            .create_conversation(None, Some("session-1"))
            .expect("create conversation");

        store
            .append_message(&conversation.id, OpsAgentRole::User, "abcdefghijklmnopqrstuvwxyz", None)
            .expect("append user");

        let loaded = store.get_conversation(&conversation.id).expect("load conversation");
        assert_eq!(loaded.title, "abcdefghij...");
    }

    #[test]
    fn split_storage_files_are_written() {
        let root = temp_dir("split-files");
        let store = OpsAgentStore::new(root.clone()).expect("create store");
        let conversation = store
            .create_conversation(None, Some("session-1"))
            .expect("create conversation");

        assert!(root.join(CONVERSATION_LIST_FILE).exists());
        assert!(
            root.join(CONVERSATIONS_DIR)
                .join(format!("{}.json", conversation.id))
                .exists()
        );
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
        assert!(
            root.join(CONVERSATIONS_DIR)
                .join("legacy-conv-1.json")
                .exists()
        );
    }
}
