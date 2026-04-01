use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::super::logging::append_debug_log;
use super::super::tools::OpsAgentToolResolveRequest;
use super::super::types::{
    OpsAgentActionStatus, OpsAgentMessage, OpsAgentPendingAction, OpsAgentResolveActionInput,
    OpsAgentResolveActionResult, OpsAgentRole,
};
use super::helpers::normalize_session_id;
use super::runtime::spawn_chat_run_task;

pub async fn resolve_pending_action(
    state: Arc<AppState>,
    app: Option<AppHandle>,
    input: OpsAgentResolveActionInput,
) -> AppResult<OpsAgentResolveActionResult> {
    let action = state.ops_agent.get_pending_action(&input.action_id)?;
    let requested_session_id = normalize_session_id(input.session_id.as_deref());
    let effective_session_id = requested_session_id
        .clone()
        .or_else(|| action.session_id.clone());
    append_debug_log(
        state.as_ref(),
        "action.resolve.request",
        None,
        Some(action.conversation_id.as_str()),
        format!(
            "action_id={} approve={} tool={} command={} action_session_id={} requested_session_id={} effective_session_id={}",
            action.id.as_str(),
            input.approve,
            action.tool_kind,
            action.command.as_str(),
            action.session_id.as_deref().unwrap_or("-"),
            requested_session_id.as_deref().unwrap_or("-"),
            effective_session_id.as_deref().unwrap_or("-"),
        ),
    );
    if action.status != OpsAgentActionStatus::Pending {
        return Err(AppError::Validation(
            "action is not pending and cannot be resolved again".to_string(),
        ));
    }

    if !input.approve {
        let updated = state.ops_agent.mark_action_rejected(&input.action_id)?;
        let notice = format!(
            "{} rejected.\nRisk: {:?}\nCommand: {}\nReason: {}",
            updated.tool_kind, updated.risk_level, updated.command, updated.reason
        );
        let _ = state.ops_agent.append_message(
            &updated.conversation_id,
            OpsAgentRole::Assistant,
            &notice,
            Some(updated.tool_kind.clone()),
            None,
        );
        return Ok(OpsAgentResolveActionResult {
            action: updated,
            note: "Action rejected".to_string(),
        });
    }

    let tool = state
        .ops_agent_tools
        .get(&action.tool_kind)
        .ok_or_else(|| {
            AppError::Validation(format!("tool {} is not registered", action.tool_kind))
        })?;
    let mut action_for_resolution = action.clone();
    if action_for_resolution.session_id != effective_session_id {
        append_debug_log(
            state.as_ref(),
            "action.resolve.session_overridden",
            None,
            Some(action_for_resolution.conversation_id.as_str()),
            format!(
                "action_id={} from={} to={}",
                action_for_resolution.id,
                action_for_resolution.session_id.as_deref().unwrap_or("-"),
                effective_session_id.as_deref().unwrap_or("-"),
            ),
        );
        action_for_resolution.session_id = effective_session_id.clone();
    }
    let resolution = tool
        .resolve_action(OpsAgentToolResolveRequest {
            state: Arc::clone(&state),
            action: action_for_resolution,
        })
        .await?;

    let tool_message = state.ops_agent.append_message(
        &resolution.action.conversation_id,
        OpsAgentRole::Tool,
        &resolution.message,
        Some(resolution.action.tool_kind.clone()),
        None,
    )?;

    if let Some(app) = app {
        maybe_resume_run_after_action_resolution(
            Arc::clone(&state),
            app,
            &resolution.action,
            &tool_message.id,
            effective_session_id.as_deref(),
        );
    }

    let note = match resolution.action.status {
        OpsAgentActionStatus::Executed => "Action approved and executed",
        OpsAgentActionStatus::Failed => "Action approved but execution failed",
        OpsAgentActionStatus::Rejected => "Action rejected",
        OpsAgentActionStatus::Pending => "Action remains pending",
    };

    Ok(OpsAgentResolveActionResult {
        action: resolution.action,
        note: note.to_string(),
    })
}

fn maybe_resume_run_after_action_resolution(
    state: Arc<AppState>,
    app: AppHandle,
    action: &OpsAgentPendingAction,
    resolved_tool_message_id: &str,
    resume_session_id_override: Option<&str>,
) {
    if !matches!(
        action.status,
        OpsAgentActionStatus::Executed | OpsAgentActionStatus::Failed
    ) {
        return;
    }

    let conversation = match state.ops_agent.get_conversation(&action.conversation_id) {
        Ok(conversation) => conversation,
        Err(error) => {
            append_debug_log(
                state.as_ref(),
                "react.resume.skipped",
                None,
                Some(action.conversation_id.as_str()),
                format!(
                    "action_id={} reason=conversation_not_found error={error}",
                    action.id
                ),
            );
            return;
        }
    };

    let Some(source_user_message_id) =
        resolve_action_source_user_message_id(&conversation.messages, action)
    else {
        append_debug_log(
            state.as_ref(),
            "react.resume.skipped",
            None,
            Some(action.conversation_id.as_str()),
            format!(
                "action_id={} reason=source_user_message_not_found",
                action.id
            ),
        );
        return;
    };

    let seed_turn_tool_history =
        match collect_turn_tool_history(&conversation.messages, &source_user_message_id) {
            Ok(messages) => messages,
            Err(error) => {
                append_debug_log(
                    state.as_ref(),
                    "react.resume.skipped",
                    None,
                    Some(action.conversation_id.as_str()),
                    format!(
                        "action_id={} reason=collect_turn_tool_history_failed error={error}",
                        action.id
                    ),
                );
                return;
            }
        };

    if !seed_turn_tool_history
        .iter()
        .any(|item| item.id == resolved_tool_message_id)
    {
        append_debug_log(
            state.as_ref(),
            "react.resume.skipped",
            None,
            Some(action.conversation_id.as_str()),
            format!(
                "action_id={} reason=resolved_tool_message_outside_source_turn",
                action.id
            ),
        );
        return;
    }

    let run_id = Uuid::new_v4().to_string();
    let run_handle = match state
        .ops_agent_runs
        .register(run_id.clone(), action.conversation_id.clone())
    {
        Ok(handle) => handle,
        Err(error) => {
            append_debug_log(
                state.as_ref(),
                "react.resume.skipped",
                Some(run_id.as_str()),
                Some(action.conversation_id.as_str()),
                format!(
                    "action_id={} reason=run_register_failed error={error}",
                    action.id
                ),
            );
            return;
        }
    };

    append_debug_log(
        state.as_ref(),
        "react.resume.started",
        Some(run_id.as_str()),
        Some(action.conversation_id.as_str()),
        format!(
            "action_id={} source_user_message_id={} seed_tool_messages={} resume_session_id={}",
            action.id,
            source_user_message_id,
            seed_turn_tool_history.len(),
            normalize_session_id(resume_session_id_override)
                .as_deref()
                .or(action.session_id.as_deref())
                .unwrap_or("-"),
        ),
    );
    let resume_session_id =
        normalize_session_id(resume_session_id_override).or_else(|| action.session_id.clone());
    spawn_chat_run_task(
        Arc::clone(&state),
        app,
        run_id,
        action.conversation_id.clone(),
        resume_session_id,
        source_user_message_id,
        run_handle,
        seed_turn_tool_history,
    );
}

fn resolve_action_source_user_message_id(
    messages: &[OpsAgentMessage],
    action: &OpsAgentPendingAction,
) -> Option<String> {
    if let Some(source_user_message_id) = action.source_user_message_id.as_deref() {
        if messages
            .iter()
            .any(|item| item.id == source_user_message_id && item.role == OpsAgentRole::User)
        {
            return Some(source_user_message_id.to_string());
        }
    }

    messages
        .iter()
        .rev()
        .find(|item| {
            item.role == OpsAgentRole::User
                && item.created_at.as_str() <= action.created_at.as_str()
        })
        .map(|item| item.id.clone())
        .or_else(|| {
            messages
                .iter()
                .rev()
                .find(|item| item.role == OpsAgentRole::User)
                .map(|item| item.id.clone())
        })
}

fn collect_turn_tool_history(
    messages: &[OpsAgentMessage],
    current_user_message_id: &str,
) -> AppResult<Vec<OpsAgentMessage>> {
    let current_index = messages
        .iter()
        .position(|item| item.id == current_user_message_id)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "ops agent message {current_user_message_id} for resolved action"
            ))
        })?;

    if messages[current_index].role != OpsAgentRole::User {
        return Err(AppError::Validation(
            "resolved action source message must be a user message".to_string(),
        ));
    }

    let mut rows = Vec::new();
    for item in messages.iter().skip(current_index + 1) {
        if item.role == OpsAgentRole::User {
            break;
        }
        if item.role == OpsAgentRole::Tool {
            rows.push(item.clone());
        }
    }

    Ok(rows)
}
