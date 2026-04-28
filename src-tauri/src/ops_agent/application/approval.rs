use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::ops_agent::core::runtime::{spawn_chat_run_task, OpsAgentChatRunTask};
use crate::ops_agent::domain::types::{
    OpsAgentActionStatus, OpsAgentExecutorResume, OpsAgentPendingAction,
    OpsAgentResolveActionInput, OpsAgentResolveActionResult, OpsAgentRunResume,
};
use crate::ops_agent::infrastructure::logging::append_debug_log;
use crate::ops_agent::tools::OpsAgentToolResolveRequest;
use crate::state::AppState;

pub async fn resolve_pending_action(
    state: Arc<AppState>,
    app: Option<AppHandle>,
    input: OpsAgentResolveActionInput,
) -> AppResult<OpsAgentResolveActionResult> {
    let action = state.ops_agent.get_pending_action(&input.action_id)?;
    let requested_session_id = normalize_session_id(input.session_id.as_deref());
    let resolution_comment = normalize_resolution_comment(input.comment.as_deref());
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
        let can_resume = app.is_some();
        let updated = state
            .ops_agent
            .mark_action_rejected(&input.action_id, resolution_comment.clone())?;
        if let Some(app) = app {
            maybe_resume_executor_after_action_resolution(
                Arc::clone(&state),
                app,
                &updated,
                effective_session_id.as_deref(),
            );
        }
        append_debug_log(
            state.as_ref(),
            "application.approval.completed",
            None,
            Some(updated.conversation_id.as_str()),
            format!(
                "action_id={} approve=false status={:?} resume_triggered={}",
                updated.id, updated.status, can_resume
            ),
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
            approval_comment: resolution_comment.clone(),
        })
        .await?;

    state.ops_agent.append_message(
        &resolution.action.conversation_id,
        crate::ops_agent::domain::types::OpsAgentRole::Tool,
        &resolution.message,
        Some(resolution.action.tool_kind.clone()),
        None,
        Vec::new(),
    )?;

    let can_resume = app.is_some();
    if let Some(app) = app {
        maybe_resume_executor_after_action_resolution(
            Arc::clone(&state),
            app,
            &resolution.action,
            effective_session_id.as_deref(),
        );
    };

    let note = match resolution.action.status {
        OpsAgentActionStatus::Executed => "Action approved and executed",
        OpsAgentActionStatus::Failed => "Action approved but execution failed",
        OpsAgentActionStatus::Rejected => "Action rejected",
        OpsAgentActionStatus::Pending => "Action remains pending",
    };
    append_debug_log(
        state.as_ref(),
        "application.approval.completed",
        None,
        Some(resolution.action.conversation_id.as_str()),
        format!(
            "action_id={} approve=true status={:?} note={} resume_triggered={}",
            resolution.action.id, resolution.action.status, note, can_resume
        ),
    );

    Ok(OpsAgentResolveActionResult {
        action: resolution.action,
        note: note.to_string(),
    })
}

fn maybe_resume_executor_after_action_resolution(
    state: Arc<AppState>,
    app: AppHandle,
    action: &OpsAgentPendingAction,
    resume_session_id_override: Option<&str>,
) {
    if !matches!(
        action.status,
        OpsAgentActionStatus::Executed
            | OpsAgentActionStatus::Failed
            | OpsAgentActionStatus::Rejected
    ) {
        return;
    };

    let Some(resume_context) = action.resume_context.clone() else {
        append_debug_log(
            state.as_ref(),
            "orchestrator.resume.skipped",
            None,
            Some(action.conversation_id.as_str()),
            format!(
                "action_id={} reason=missing_executor_resume_context",
                action.id
            ),
        );
        return;
    };

    let Some(source_user_message_id) = action.source_user_message_id.clone() else {
        append_debug_log(
            state.as_ref(),
            "orchestrator.resume.skipped",
            None,
            Some(action.conversation_id.as_str()),
            format!(
                "action_id={} reason=missing_source_user_message_id",
                action.id
            ),
        );
        return;
    };

    let run_id = Uuid::new_v4().to_string();
    let run_handle = match state
        .ops_agent_runs
        .register(run_id.clone(), action.conversation_id.clone())
    {
        Ok(handle) => handle,
        Err(error) => {
            append_debug_log(
                state.as_ref(),
                "orchestrator.resume.skipped",
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
        "orchestrator.resume.started",
        Some(run_id.as_str()),
        Some(action.conversation_id.as_str()),
        format!(
            "action_id={} source_user_message_id={} restored_execution_steps={} resume_session_id={}",
            action.id,
            source_user_message_id,
            resume_context.execution_steps.len(),
            normalize_session_id(resume_session_id_override)
                .as_deref()
                .or(action.session_id.as_deref())
                .unwrap_or("-"),
        ),
    );
    let resume_session_id =
        normalize_session_id(resume_session_id_override).or_else(|| action.session_id.clone());
    spawn_chat_run_task(OpsAgentChatRunTask {
        state: Arc::clone(&state),
        app,
        run_id,
        conversation_id: action.conversation_id.clone(),
        session_id: resume_session_id,
        current_user_message_id: source_user_message_id,
        run_handle,
        resume: Some(OpsAgentRunResume::Executor(OpsAgentExecutorResume {
            context: resume_context,
            resolved_action: action.clone(),
        })),
    });
}

fn normalize_resolution_comment(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_session_id(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

