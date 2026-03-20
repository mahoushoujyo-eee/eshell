use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::models::CommandExecutionResult;
use crate::ssh_service;

use super::{
    format_execution_output, OpsAgentTool, OpsAgentToolDefinition, OpsAgentToolExecution,
    OpsAgentToolOutcome, OpsAgentToolRequest, OpsAgentToolResolution, OpsAgentToolResolveRequest,
    ToolFuture,
};
use crate::ops_agent::types::{OpsAgentActionStatus, OpsAgentToolKind};

/// Read-only shell diagnostics tool.
pub struct ReadShellTool;

/// Mutating shell command tool guarded by explicit approval.
pub struct WriteShellTool;

impl OpsAgentTool for ReadShellTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::read_shell(),
            description: "Safe read-only shell diagnostics such as ls, cat, grep, df, free, ps, top, or uptime."
                .to_string(),
            usage_notes: vec![
                "Use only for commands that inspect state without changing it.".to_string(),
            ],
            requires_approval: false,
        }
    }

    fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> ToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let session_id = request.session_id.ok_or_else(|| {
                AppError::Validation("read_shell requires an active SSH session".to_string())
            })?;
            let command = request.command.trim().to_string();
            if command.is_empty() {
                return Err(AppError::Validation(
                    "read_shell command cannot be empty".to_string(),
                ));
            }

            let execution = execute_remote_command(request.state, session_id, command.clone()).await?;
            let output = format_execution_output(&execution.stdout, &execution.stderr, execution.exit_code);

            Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                tool_kind: OpsAgentToolKind::read_shell(),
                command: command.clone(),
                output: output.clone(),
                exit_code: Some(execution.exit_code),
                message: format!(
                    "read_shell executed.\nCommand: {command}\nExit: {}\n{output}",
                    execution.exit_code
                ),
                stream_label: Some(format!("read_shell: {command}")),
            }))
        })
    }
}

impl OpsAgentTool for WriteShellTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::write_shell(),
            description: "Mutating shell commands that change system state, edit files, restart services, or remove resources."
                .to_string(),
            usage_notes: vec![
                "Every planned command must be queued for explicit approval before execution."
                    .to_string(),
            ],
            requires_approval: true,
        }
    }

    fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> ToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let command = request.command.trim().to_string();
            if command.is_empty() {
                return Err(AppError::Validation(
                    "write_shell command cannot be empty".to_string(),
                ));
            }

            let action = request.state.ops_agent.create_pending_action(
                &request.conversation_id,
                request.session_id.as_deref(),
                OpsAgentToolKind::write_shell(),
                &command,
                request
                    .reason
                    .as_deref()
                    .unwrap_or("requested by agent"),
            )?;

            Ok(OpsAgentToolOutcome::AwaitingApproval(action))
        })
    }

    fn resolve_action(
        self: Arc<Self>,
        request: OpsAgentToolResolveRequest,
    ) -> ToolFuture<OpsAgentToolResolution> {
        let _ = self;
        Box::pin(async move {
            let action = request.action;
            if action.status != OpsAgentActionStatus::Pending {
                return Err(AppError::Validation(
                    "action is not pending and cannot be resolved again".to_string(),
                ));
            }

            let Some(session_id) = action.session_id.clone() else {
                let updated = request
                    .state
                    .ops_agent
                    .mark_action_failed(&action.id, "missing session id for write_shell".to_string())?;
                return Ok(OpsAgentToolResolution {
                    message: format!(
                        "write_shell failed.\nCommand: {}\nReason: missing session id.",
                        updated.command
                    ),
                    action: updated,
                });
            };

            let command = action.command.clone();
            let execution = execute_remote_command(request.state.clone(), session_id, command.clone()).await;
            match execution {
                Ok(execution) => {
                    let output =
                        format_execution_output(&execution.stdout, &execution.stderr, execution.exit_code);
                    let updated = request.state.ops_agent.mark_action_executed(
                        &action.id,
                        output.clone(),
                        execution.exit_code,
                    )?;
                    Ok(OpsAgentToolResolution {
                        message: format!(
                            "write_shell executed.\nCommand: {command}\nExit: {}\n{output}",
                            execution.exit_code
                        ),
                        action: updated,
                    })
                }
                Err(error) => {
                    let updated = request
                        .state
                        .ops_agent
                        .mark_action_failed(&action.id, error.to_string())?;
                    Ok(OpsAgentToolResolution {
                        message: format!(
                            "write_shell failed.\nCommand: {command}\nError: {error}",
                        ),
                        action: updated,
                    })
                }
            }
        })
    }
}

async fn execute_remote_command(
    state: Arc<crate::state::AppState>,
    session_id: String,
    command: String,
) -> AppResult<CommandExecutionResult> {
    tauri::async_runtime::spawn_blocking(move || ssh_service::execute_command(&state, &session_id, &command))
        .await
        .map_err(|error| AppError::Runtime(error.to_string()))?
}
