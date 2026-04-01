use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::state::AppState;

use super::super::logging::append_debug_log;
use super::super::types::{
    OpsAgentCancelRunResult, OpsAgentChatAccepted, OpsAgentChatInput, OpsAgentConversation,
    OpsAgentConversationSummary, OpsAgentPendingAction, OpsAgentRole,
};
use super::helpers::truncate_for_log;
use super::runtime::spawn_chat_run_task;

pub fn list_conversations(state: &AppState) -> Vec<OpsAgentConversationSummary> {
    state.ops_agent.list_conversation_summaries()
}

pub fn create_conversation(
    state: &AppState,
    title: Option<&str>,
    session_id: Option<&str>,
) -> AppResult<OpsAgentConversation> {
    state.ops_agent.create_conversation(title, session_id)
}

pub fn get_conversation(
    state: &AppState,
    conversation_id: &str,
) -> AppResult<OpsAgentConversation> {
    state.ops_agent.get_conversation(conversation_id)
}

pub fn delete_conversation(state: &AppState, conversation_id: &str) -> AppResult<()> {
    state.ops_agent.delete_conversation(conversation_id)
}

pub fn set_active_conversation(state: &AppState, conversation_id: &str) -> AppResult<()> {
    state.ops_agent.set_active_conversation(conversation_id)
}

pub fn list_pending_actions(
    state: &AppState,
    session_id: Option<&str>,
    only_pending: bool,
) -> Vec<OpsAgentPendingAction> {
    state
        .ops_agent
        .list_pending_actions(session_id, only_pending)
}

pub fn cancel_chat_run(state: &AppState, run_id: &str) -> AppResult<OpsAgentCancelRunResult> {
    let cancelled = state.ops_agent_runs.cancel(run_id)?;
    let note = if cancelled {
        "Cancel signal sent".to_string()
    } else {
        "Run was already cancelling".to_string()
    };
    append_debug_log(
        state,
        "chat.cancel.request",
        Some(run_id),
        None,
        format!("cancelled={cancelled}"),
    );

    Ok(OpsAgentCancelRunResult {
        run_id: run_id.to_string(),
        cancelled,
        note,
    })
}

pub fn start_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    input: OpsAgentChatInput,
) -> AppResult<OpsAgentChatAccepted> {
    let question = input.question.trim().to_string();
    append_debug_log(
        state.as_ref(),
        "chat.request",
        None,
        input.conversation_id.as_deref(),
        format!(
            "session_id={} question={}",
            input.session_id.as_deref().unwrap_or("-"),
            truncate_for_log(&question, 220)
        ),
    );
    if question.is_empty() {
        append_debug_log(
            state.as_ref(),
            "chat.validation_failed",
            None,
            input.conversation_id.as_deref(),
            "question cannot be empty",
        );
        return Err(AppError::Validation("question cannot be empty".to_string()));
    }

    let conversation = state.ops_agent.ensure_conversation(
        input.conversation_id.as_deref(),
        &question,
        input.session_id.as_deref(),
    )?;
    let session_id = conversation.session_id.clone();
    if let Some(requested_session_id) = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if session_id.as_deref() != Some(requested_session_id) {
            append_debug_log(
                state.as_ref(),
                "chat.session_binding_mismatch",
                None,
                Some(conversation.id.as_str()),
                format!(
                    "requested_session_id={} conversation_session_id={}",
                    requested_session_id,
                    session_id.as_deref().unwrap_or("-")
                ),
            );
        }
    }
    let run_id = Uuid::new_v4().to_string();
    let run_handle = state
        .ops_agent_runs
        .register(run_id.clone(), conversation.id.clone())?;
    let user_message = match state.ops_agent.append_message(
        &conversation.id,
        OpsAgentRole::User,
        &question,
        None,
        input.shell_context,
    ) {
        Ok(message) => message,
        Err(error) => {
            state.ops_agent_runs.finish(&run_id);
            return Err(error);
        }
    };
    let accepted = OpsAgentChatAccepted {
        run_id: run_id.clone(),
        conversation_id: conversation.id.clone(),
        started_at: now_rfc3339(),
    };
    append_debug_log(
        state.as_ref(),
        "chat.accepted",
        Some(run_id.as_str()),
        Some(conversation.id.as_str()),
        format!(
            "session_id={} message_id={}",
            session_id.as_deref().unwrap_or("-"),
            user_message.id.as_str()
        ),
    );

    spawn_chat_run_task(
        Arc::clone(&state),
        app,
        run_id.clone(),
        conversation.id.clone(),
        session_id,
        user_message.id,
        run_handle,
        Vec::new(),
    );

    Ok(accepted)
}
