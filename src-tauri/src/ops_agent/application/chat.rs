use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::ops_agent::core::helpers::truncate_for_log;
use crate::ops_agent::core::runtime::spawn_chat_run_task;
use crate::ops_agent::domain::types::{
    OpsAgentCancelRunResult, OpsAgentChatAccepted, OpsAgentChatInput, OpsAgentConversation,
    OpsAgentConversationSummary, OpsAgentPendingAction, OpsAgentRole,
};
use crate::ops_agent::infrastructure::logging::append_debug_log;
use crate::state::AppState;

pub fn list_conversations(state: &AppState) -> Vec<OpsAgentConversationSummary> {
    let conversations = state.ops_agent.list_conversation_summaries();
    append_debug_log(
        state,
        "application.chat.list_conversations",
        None,
        None,
        format!("count={}", conversations.len()),
    );
    conversations
}

pub fn create_conversation(
    state: &AppState,
    title: Option<&str>,
    session_id: Option<&str>,
) -> AppResult<OpsAgentConversation> {
    let conversation = state.ops_agent.create_conversation(title, session_id)?;
    append_debug_log(
        state,
        "application.chat.create_conversation",
        None,
        Some(conversation.id.as_str()),
        format!(
            "title={} session_id={}",
            truncate_for_log(conversation.title.as_str(), 120),
            conversation.session_id.as_deref().unwrap_or("-")
        ),
    );
    Ok(conversation)
}

pub fn get_conversation(
    state: &AppState,
    conversation_id: &str,
) -> AppResult<OpsAgentConversation> {
    let conversation = state.ops_agent.get_conversation(conversation_id)?;
    append_debug_log(
        state,
        "application.chat.get_conversation",
        None,
        Some(conversation_id),
        format!("message_count={}", conversation.messages.len()),
    );
    Ok(conversation)
}

pub fn delete_conversation(state: &AppState, conversation_id: &str) -> AppResult<()> {
    let attachment_ids = state
        .ops_agent
        .get_conversation(conversation_id)?
        .messages
        .into_iter()
        .flat_map(|message| message.attachment_ids)
        .collect::<Vec<_>>();
    state.ops_agent.delete_conversation(conversation_id)?;
    if let Err(error) = state
        .ops_agent_attachments
        .delete_attachments(&attachment_ids)
    {
        append_debug_log(
            state,
            "application.chat.delete_conversation.attachments_failed",
            None,
            Some(conversation_id),
            format!("attachment_count={} error={error}", attachment_ids.len()),
        );
    }
    append_debug_log(
        state,
        "application.chat.delete_conversation",
        None,
        Some(conversation_id),
        format!(
            "conversation deleted attachment_count={}",
            attachment_ids.len()
        ),
    );
    Ok(())
}

pub fn set_active_conversation(state: &AppState, conversation_id: &str) -> AppResult<()> {
    state.ops_agent.set_active_conversation(conversation_id)?;
    append_debug_log(
        state,
        "application.chat.set_active_conversation",
        None,
        Some(conversation_id),
        "active conversation set",
    );
    Ok(())
}

pub fn list_pending_actions(
    state: &AppState,
    session_id: Option<&str>,
    only_pending: bool,
) -> Vec<OpsAgentPendingAction> {
    let actions = state
        .ops_agent
        .list_pending_actions(session_id, only_pending);
    append_debug_log(
        state,
        "application.chat.list_pending_actions",
        None,
        None,
        format!(
            "session_id={} only_pending={} count={}",
            session_id.unwrap_or("-"),
            only_pending,
            actions.len()
        ),
    );
    actions
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
    let image_attachments = input.image_attachments;
    append_debug_log(
        state.as_ref(),
        "chat.request",
        None,
        input.conversation_id.as_deref(),
        format!(
            "session_id={} question={} image_attachment_count={}",
            input.session_id.as_deref().unwrap_or("-"),
            truncate_for_log(&question, 220),
            image_attachments.len()
        ),
    );
    if question.is_empty() && image_attachments.is_empty() {
        append_debug_log(
            state.as_ref(),
            "chat.validation_failed",
            None,
            input.conversation_id.as_deref(),
            "question cannot be empty when no image attachments are provided",
        );
        return Err(AppError::Validation(
            "question cannot be empty when no image attachments are provided".to_string(),
        ));
    }

    let title_hint = if question.is_empty() {
        "Image upload"
    } else {
        question.as_str()
    };
    let conversation = state.ops_agent.ensure_conversation(
        input.conversation_id.as_deref(),
        title_hint,
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
    let attachment_ids = state
        .ops_agent_attachments
        .save_image_uploads(&image_attachments)?;
    let run_id = Uuid::new_v4().to_string();
    let run_handle = match state
        .ops_agent_runs
        .register(run_id.clone(), conversation.id.clone())
    {
        Ok(handle) => handle,
        Err(error) => {
            let _ = state
                .ops_agent_attachments
                .delete_attachments(&attachment_ids);
            return Err(error);
        }
    };
    let user_message = match state.ops_agent.append_message(
        &conversation.id,
        OpsAgentRole::User,
        &question,
        None,
        input.shell_context,
        attachment_ids.clone(),
    ) {
        Ok(message) => message,
        Err(error) => {
            state.ops_agent_runs.finish(&run_id);
            let _ = state
                .ops_agent_attachments
                .delete_attachments(&attachment_ids);
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
            "session_id={} message_id={} image_attachment_count={}",
            session_id.as_deref().unwrap_or("-"),
            user_message.id.as_str(),
            attachment_ids.len()
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
