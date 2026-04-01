use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::state::AppState;

use super::context::load_session_context;
use super::events::OpsAgentEventEmitter;
use super::logging::append_debug_log;
use super::openai;
use super::run_registry::OpsAgentRunHandle;
use super::tools::{OpsAgentToolOutcome, OpsAgentToolResolveRequest};
use super::types::{
    OpsAgentActionStatus, OpsAgentCancelRunResult, OpsAgentChatAccepted, OpsAgentChatInput,
    OpsAgentConversation, OpsAgentConversationSummary, OpsAgentMessage, OpsAgentPendingAction,
    OpsAgentResolveActionInput, OpsAgentResolveActionResult, OpsAgentRole,
};

const OPS_AGENT_RUN_CANCELLED: &str = "__ops_agent_run_cancelled__";
const OPS_AGENT_MAX_REACT_STEPS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessChatOutcome {
    Completed,
    Cancelled,
}

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

pub fn get_conversation(state: &AppState, conversation_id: &str) -> AppResult<OpsAgentConversation> {
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
) -> Vec<super::types::OpsAgentPendingAction> {
    state.ops_agent.list_pending_actions(session_id, only_pending)
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

    let state_for_task = Arc::clone(&state);
    let app_for_task = app.clone();
    let run_id_for_task = run_id.clone();
    let conversation_id_for_task = conversation.id.clone();
    tauri::async_runtime::spawn(async move {
        let result = process_chat_stream(
            Arc::clone(&state_for_task),
            app_for_task.clone(),
            run_id_for_task.clone(),
            conversation_id_for_task.clone(),
            session_id,
            user_message.id,
            run_handle.clone(),
        )
        .await;
        state_for_task
            .ops_agent_runs
            .finish(&run_id_for_task);

        match result {
            Ok(ProcessChatOutcome::Completed) => {
                append_debug_log(
                    state_for_task.as_ref(),
                    "chat.completed",
                    Some(run_id_for_task.as_str()),
                    Some(conversation_id_for_task.as_str()),
                    "stream finished",
                );
            }
            Ok(ProcessChatOutcome::Cancelled) => {
                append_debug_log(
                    state_for_task.as_ref(),
                    "chat.cancelled",
                    Some(run_id_for_task.as_str()),
                    Some(conversation_id_for_task.as_str()),
                    "run cancelled by user",
                );
                OpsAgentEventEmitter::new(
                    app_for_task,
                    run_id_for_task,
                    conversation_id_for_task,
                )
                .completed(String::new(), None);
            }
            Err(error) => {
                append_debug_log(
                    state_for_task.as_ref(),
                    "chat.error",
                    Some(run_id_for_task.as_str()),
                    Some(conversation_id_for_task.as_str()),
                    error.to_string(),
                );
                if is_run_cancelled_error(&error) {
                    OpsAgentEventEmitter::new(
                        app_for_task,
                        run_id_for_task,
                        conversation_id_for_task,
                    )
                    .completed(String::new(), None);
                    return;
                }
                OpsAgentEventEmitter::new(
                    app_for_task,
                    run_id_for_task,
                    conversation_id_for_task,
                )
                .error(error.to_string());
            }
        }
    });

    Ok(accepted)
}

pub async fn resolve_pending_action(
    state: Arc<AppState>,
    input: OpsAgentResolveActionInput,
) -> AppResult<OpsAgentResolveActionResult> {
    let action = state.ops_agent.get_pending_action(&input.action_id)?;
    append_debug_log(
        state.as_ref(),
        "action.resolve.request",
        None,
        Some(action.conversation_id.as_str()),
        format!(
            "action_id={} approve={} tool={} command={}",
            action.id.as_str(),
            input.approve,
            action.tool_kind,
            action.command.as_str()
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
            updated.tool_kind,
            updated.risk_level,
            updated.command,
            updated.reason
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
        .ok_or_else(|| AppError::Validation(format!("tool {} is not registered", action.tool_kind)))?;
    let resolution = tool
        .resolve_action(OpsAgentToolResolveRequest {
            state: Arc::clone(&state),
            action,
        })
        .await?;

    let _ = state.ops_agent.append_message(
        &resolution.action.conversation_id,
        OpsAgentRole::Tool,
        &resolution.message,
        Some(resolution.action.tool_kind.clone()),
        None,
    );

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

async fn process_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    session_id: Option<String>,
    current_user_message_id: String,
    run_handle: OpsAgentRunHandle,
) -> AppResult<ProcessChatOutcome> {
    let run_id_for_log = run_id.clone();
    let emitter = OpsAgentEventEmitter::new(app, run_id, conversation_id.clone());
    emitter.started();
    append_debug_log(
        state.as_ref(),
        "run.started",
        Some(run_id_for_log.as_str()),
        Some(conversation_id.as_str()),
        format!(
            "session_id={} current_message_id={}",
            session_id.as_deref().unwrap_or("-"),
            current_user_message_id
        ),
    );
    if run_handle.is_cancelled() {
        return Ok(ProcessChatOutcome::Cancelled);
    }

    let config = state.storage.get_ai_config();
    let conversation = state.ops_agent.get_conversation(&conversation_id)?;
    let (history, current_user_message) =
        split_history_for_current_message(conversation.messages, &current_user_message_id)?;
    let session_context = load_session_context(&state, session_id.as_deref());
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let mut working_history = history;
    let mut last_planner_reply = String::new();

    for step in 0..OPS_AGENT_MAX_REACT_STEPS {
        if run_handle.is_cancelled() {
            return Ok(ProcessChatOutcome::Cancelled);
        }

        let plan = openai::plan_reply(
            &config,
            &working_history,
            &current_user_message,
            &session_context,
            &tool_hints,
        )
        .await?;
        last_planner_reply = plan.reply.clone();
        append_debug_log(
            state.as_ref(),
            "react.plan",
            Some(run_id_for_log.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "step={} tool={} command={} reply={}",
                step + 1,
                plan.tool.kind,
                plan.tool.command.as_deref().unwrap_or("<none>"),
                truncate_for_log(plan.reply.as_str(), 200)
            ),
        );

        if plan.tool.kind.is_none() {
            let assistant_answer = match stream_answer_with_fallback(
                &config,
                &working_history,
                &current_user_message,
                &session_context,
                Some(plan.reply.as_str()),
                &emitter,
                &run_handle,
            )
            .await
            {
                Ok(answer) => answer,
                Err(error) if is_run_cancelled_error(&error) => {
                    return Ok(ProcessChatOutcome::Cancelled);
                }
                Err(error) => return Err(error),
            };
            return finalize_chat_completion(
                &state,
                &conversation_id,
                assistant_answer,
                None,
                &emitter,
            );
        }

        let tool = state
            .ops_agent_tools
            .get(&plan.tool.kind)
            .ok_or_else(|| AppError::Validation(format!("tool {} is not registered", plan.tool.kind)))?;
        let command = if plan.tool.kind == super::types::OpsAgentToolKind::ui_context() {
            plan.tool.command.clone().unwrap_or_default()
        } else if let Some(command) = plan.tool.command.clone() {
            command
        } else {
            let assistant_answer = emit_static_reply(
                normalized_reply(
                    plan.reply,
                    &format!(
                        "Tool {} was selected without an executable command. Stopping here.",
                        plan.tool.kind
                    ),
                ),
                &emitter,
            );
            return finalize_chat_completion(
                &state,
                &conversation_id,
                assistant_answer,
                None,
                &emitter,
            );
        };

        if run_handle.is_cancelled() {
            return Ok(ProcessChatOutcome::Cancelled);
        }

        let outcome = tool
            .execute(super::tools::OpsAgentToolRequest {
                state: Arc::clone(&state),
                conversation_id: conversation_id.clone(),
                session_id: session_id.clone(),
                command: command.clone(),
                reason: plan.tool.reason.clone(),
            })
            .await;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                append_debug_log(
                    state.as_ref(),
                    "react.tool_error",
                    Some(run_id_for_log.as_str()),
                    Some(conversation_id.as_str()),
                    format!("tool={} command={} error={error}", plan.tool.kind, command),
                );
                return Err(error);
            }
        };

        match outcome {
            OpsAgentToolOutcome::Executed(execution) => {
                if run_handle.is_cancelled() {
                    return Ok(ProcessChatOutcome::Cancelled);
                }

                let tool_message = state.ops_agent.append_message(
                    &conversation_id,
                    OpsAgentRole::Tool,
                    &execution.message,
                    Some(execution.tool_kind.clone()),
                    None,
                )?;
                working_history.push(tool_message);

                let label = execution
                    .stream_label
                    .unwrap_or_else(|| format!("{} step {}", execution.tool_kind, step + 1));
                emitter.tool_read(label);
            }
            OpsAgentToolOutcome::AwaitingApproval(action) => {
                if run_handle.is_cancelled() {
                    return Ok(ProcessChatOutcome::Cancelled);
                }
                emitter.requires_approval(action.clone());
                let approval_message = if plan.reply.trim().is_empty() {
                    format!(
                        "Command `{}` needs approval before execution.\nReason: {}\nPlease approve or reject it in the UI.",
                        action.command, action.reason
                    )
                } else {
                    format!(
                        "{}\n\nCommand `{}` needs approval before execution.\nReason: {}\nPlease approve or reject it in the UI.",
                        plan.reply.trim(),
                        action.command,
                        action.reason
                    )
                };
                let assistant_answer = emit_static_reply(
                    approval_message,
                    &emitter,
                );
                return finalize_chat_completion(
                    &state,
                    &conversation_id,
                    assistant_answer,
                    Some(action),
                    &emitter,
                );
            }
        }
    }

    let step_limit_hint = format!(
        "I reached the autonomous tool step limit ({OPS_AGENT_MAX_REACT_STEPS})."
    );
    let planner_reply_on_limit = normalized_reply(last_planner_reply, &step_limit_hint);
    let assistant_answer = match stream_answer_with_fallback(
        &config,
        &working_history,
        &current_user_message,
        &session_context,
        Some(planner_reply_on_limit.as_str()),
        &emitter,
        &run_handle,
    )
    .await
    {
        Ok(answer) => answer,
        Err(error) if is_run_cancelled_error(&error) => {
            return Ok(ProcessChatOutcome::Cancelled);
        }
        Err(error) => return Err(error),
    };

    finalize_chat_completion(
        &state,
        &conversation_id,
        assistant_answer,
        None,
        &emitter,
    )
}

fn finalize_chat_completion(
    state: &AppState,
    conversation_id: &str,
    assistant_answer: String,
    pending_action: Option<OpsAgentPendingAction>,
    emitter: &OpsAgentEventEmitter,
) -> AppResult<ProcessChatOutcome> {
    state.ops_agent.append_message(
        conversation_id,
        OpsAgentRole::Assistant,
        &assistant_answer,
        None,
        None,
    )?;
    emitter.completed(assistant_answer, pending_action);
    Ok(ProcessChatOutcome::Completed)
}

fn split_history_for_current_message(
    messages: Vec<OpsAgentMessage>,
    current_message_id: &str,
) -> AppResult<(Vec<OpsAgentMessage>, OpsAgentMessage)> {
    let current_index = messages
        .iter()
        .position(|item| item.id == current_message_id)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "ops agent message {current_message_id} for active chat run"
            ))
        })?;
    let current_message = messages[current_index].clone();
    if current_message.role != OpsAgentRole::User {
        return Err(AppError::Validation(
            "active chat run message must be a user message".to_string(),
        ));
    }

    let history = messages.into_iter().take(current_index).collect::<Vec<_>>();

    Ok((history, current_message))
}

async fn stream_answer_with_fallback(
    config: &crate::models::AiConfig,
    history: &[super::types::OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &super::context::OpsAgentSessionContext,
    planner_reply: Option<&str>,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
) -> AppResult<String> {
    match openai::stream_final_answer(
        config,
        history,
        current_message,
        session_context,
        planner_reply,
        |delta| {
            ensure_run_not_cancelled(run_handle)?;
            emitter.delta(delta.to_string());
            Ok(())
        },
    )
    .await
    {
        Ok(answer) => Ok(answer),
        Err(error) => {
            if is_run_cancelled_error(&error) {
                return Err(error);
            }
            let fallback = normalized_reply(
                planner_reply.unwrap_or_default().to_string(),
                "Received. I will help with this operations task.",
            );
            if fallback.trim().is_empty() {
                return Err(error);
            }
            Ok(emit_static_reply(fallback, emitter))
        }
    }
}

fn emit_static_reply(text: String, emitter: &OpsAgentEventEmitter) -> String {
    emitter.delta(text.clone());
    text
}

fn ensure_run_not_cancelled(run_handle: &OpsAgentRunHandle) -> AppResult<()> {
    if run_handle.is_cancelled() {
        return Err(AppError::Runtime(OPS_AGENT_RUN_CANCELLED.to_string()));
    }
    Ok(())
}

fn is_run_cancelled_error(error: &AppError) -> bool {
    matches!(error, AppError::Runtime(message) if message == OPS_AGENT_RUN_CANCELLED)
}

fn normalized_reply(reply: String, fallback: &str) -> String {
    if reply.trim().is_empty() {
        fallback.to_string()
    } else {
        reply
    }
}

fn truncate_for_log(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::future::Future;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::ops_agent::tools::{
        OpsAgentTool, OpsAgentToolDefinition, OpsAgentToolExecution, OpsAgentToolOutcome,
        OpsAgentToolRegistry, OpsAgentToolRequest, OpsAgentToolResolution, OpsAgentToolResolveRequest,
    };
    use crate::ops_agent::types::{
        OpsAgentRiskLevel, OpsAgentToolKind, PlannedAgentReply, PlannedToolAction,
    };
    use crate::state::AppState;

    type TestToolFuture<T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'static>>;

    struct MockInspectTool;
    struct MockDiagnoseTool;
    struct MockDangerTool;

    impl OpsAgentTool for MockInspectTool {
        fn definition(&self) -> OpsAgentToolDefinition {
            OpsAgentToolDefinition {
                kind: OpsAgentToolKind::new("mock_inspect"),
                description: "Collect runtime metrics.".to_string(),
                usage_notes: vec!["Used in multi-turn tests.".to_string()],
                requires_approval: false,
            }
        }

        fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> TestToolFuture<OpsAgentToolOutcome> {
            let _ = self;
            Box::pin(async move {
                let output = format!("metrics collected for `{}`: cpu=97 mem=88", request.command);
                Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                    tool_kind: OpsAgentToolKind::new("mock_inspect"),
                    command: request.command,
                    output: output.clone(),
                    exit_code: Some(0),
                    message: output,
                    stream_label: Some("mock_inspect".to_string()),
                }))
            })
        }
    }

    impl OpsAgentTool for MockDiagnoseTool {
        fn definition(&self) -> OpsAgentToolDefinition {
            OpsAgentToolDefinition {
                kind: OpsAgentToolKind::new("mock_diagnose"),
                description: "Diagnose top process.".to_string(),
                usage_notes: vec!["Used in multi-turn tests.".to_string()],
                requires_approval: false,
            }
        }

        fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> TestToolFuture<OpsAgentToolOutcome> {
            let _ = self;
            Box::pin(async move {
                let output = format!(
                    "diagnosis for `{}`: process=java pid=22131 cpu=96",
                    request.command
                );
                Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                    tool_kind: OpsAgentToolKind::new("mock_diagnose"),
                    command: request.command,
                    output: output.clone(),
                    exit_code: Some(0),
                    message: output,
                    stream_label: Some("mock_diagnose".to_string()),
                }))
            })
        }
    }

    impl OpsAgentTool for MockDangerTool {
        fn definition(&self) -> OpsAgentToolDefinition {
            OpsAgentToolDefinition {
                kind: OpsAgentToolKind::new("mock_danger"),
                description: "Dangerous mutating operation that always requires approval.".to_string(),
                usage_notes: vec!["Used in approval tests.".to_string()],
                requires_approval: true,
            }
        }

        fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> TestToolFuture<OpsAgentToolOutcome> {
            let _ = self;
            Box::pin(async move {
                let action = request.state.ops_agent.create_pending_action(
                    &request.conversation_id,
                    request.session_id.as_deref(),
                    OpsAgentToolKind::new("mock_danger"),
                    OpsAgentRiskLevel::High,
                    &request.command,
                    request
                        .reason
                        .as_deref()
                        .unwrap_or("mock danger operation"),
                )?;
                Ok(OpsAgentToolOutcome::AwaitingApproval(action))
            })
        }

        fn resolve_action(
            self: Arc<Self>,
            request: OpsAgentToolResolveRequest,
        ) -> TestToolFuture<OpsAgentToolResolution> {
            let _ = self;
            Box::pin(async move {
                let updated = request.state.ops_agent.mark_action_executed(
                    &request.action.id,
                    "mock danger executed".to_string(),
                    0,
                )?;
                Ok(OpsAgentToolResolution {
                    message: "mock danger resolved".to_string(),
                    action: updated,
                })
            })
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        env::temp_dir().join(format!("eshell-ops-agent-service-{name}-{stamp}"))
    }

    fn test_state_with_registry(registry: OpsAgentToolRegistry) -> Arc<AppState> {
        Arc::new(
            AppState::new_with_ops_agent_tools(temp_dir("react-loop"), registry)
                .expect("create app state"),
        )
    }

    async fn run_mock_react_loop<F>(
        state: Arc<AppState>,
        conversation_id: &str,
        session_id: Option<&str>,
        question: &str,
        mut planner: F,
    ) -> AppResult<(String, Option<OpsAgentPendingAction>)>
    where
        F: FnMut(&[OpsAgentMessage], &OpsAgentMessage) -> PlannedAgentReply,
    {
        let user_message = state.ops_agent.append_message(
            conversation_id,
            OpsAgentRole::User,
            question,
            None,
            None,
        )?;
        let conversation = state.ops_agent.get_conversation(conversation_id)?;
        let (mut history, current_user_message) =
            split_history_for_current_message(conversation.messages, &user_message.id)?;

        for _ in 0..OPS_AGENT_MAX_REACT_STEPS {
            let plan = planner(&history, &current_user_message);
            if plan.tool.kind.is_none() {
                let final_answer = normalized_reply(
                    plan.reply,
                    "No final answer was generated by planner.",
                );
                state.ops_agent.append_message(
                    conversation_id,
                    OpsAgentRole::Assistant,
                    &final_answer,
                    None,
                    None,
                )?;
                return Ok((final_answer, None));
            }

            let tool = state
                .ops_agent_tools
                .get(&plan.tool.kind)
                .ok_or_else(|| AppError::Validation(format!("tool {} is not registered", plan.tool.kind)))?;
            let command = plan.tool.command.unwrap_or_default();

            match tool
                .execute(crate::ops_agent::tools::OpsAgentToolRequest {
                    state: Arc::clone(&state),
                    conversation_id: conversation_id.to_string(),
                    session_id: session_id.map(|item| item.to_string()),
                    command,
                    reason: plan.tool.reason,
                })
                .await?
            {
                OpsAgentToolOutcome::Executed(execution) => {
                    let tool_message = state.ops_agent.append_message(
                        conversation_id,
                        OpsAgentRole::Tool,
                        &execution.message,
                        Some(execution.tool_kind),
                        None,
                    )?;
                    history.push(tool_message);
                }
                OpsAgentToolOutcome::AwaitingApproval(action) => {
                    let prompt = format!(
                        "Command `{}` needs approval before execution.\nReason: {}",
                        action.command, action.reason
                    );
                    state.ops_agent.append_message(
                        conversation_id,
                        OpsAgentRole::Assistant,
                        &prompt,
                        None,
                        None,
                    )?;
                    return Ok((prompt, Some(action)));
                }
            }
        }

        let limit_message = format!(
            "I reached the autonomous tool step limit ({OPS_AGENT_MAX_REACT_STEPS})."
        );
        state.ops_agent.append_message(
            conversation_id,
            OpsAgentRole::Assistant,
            &limit_message,
            None,
            None,
        )?;
        Ok((limit_message, None))
    }

    #[test]
    fn react_loop_runs_multi_turn_reasoning_with_mock_tools() {
        let mut registry = OpsAgentToolRegistry::new();
        registry.register(MockInspectTool);
        registry.register(MockDiagnoseTool);

        let state = test_state_with_registry(registry);
        let conversation = state
            .ops_agent
            .create_conversation(Some("multi-turn"), None)
            .expect("create conversation");

        let mut planner_calls = 0usize;
        let (answer, pending_action) = tauri::async_runtime::block_on(run_mock_react_loop(
            Arc::clone(&state),
            &conversation.id,
            None,
            "线上 CPU 抖动，帮我定位根因。",
            |history, _current_user_message| {
                planner_calls += 1;
                let has_metrics = history.iter().any(|item| item.content.contains("cpu=97"));
                let has_java_diagnosis = history
                    .iter()
                    .any(|item| item.content.contains("process=java"));

                if !has_metrics {
                    return PlannedAgentReply {
                        reply: "先读取核心指标，确认是否资源瓶颈。".to_string(),
                        tool: PlannedToolAction {
                            kind: OpsAgentToolKind::new("mock_inspect"),
                            command: Some("collect_runtime_metrics".to_string()),
                            reason: Some("need baseline metrics".to_string()),
                        },
                    };
                }

                if !has_java_diagnosis {
                    return PlannedAgentReply {
                        reply: "指标异常，再看热点进程定位来源。".to_string(),
                        tool: PlannedToolAction {
                            kind: OpsAgentToolKind::new("mock_diagnose"),
                            command: Some("find_hot_process".to_string()),
                            reason: Some("identify culprit process".to_string()),
                        },
                    };
                }

                PlannedAgentReply {
                    reply:
                        "已定位：CPU 抖动主要由 Java 进程引起（pid=22131，cpu≈96%）。建议先抓线程栈再限制并发。"
                            .to_string(),
                    tool: PlannedToolAction {
                        kind: OpsAgentToolKind::none(),
                        command: None,
                        reason: None,
                    },
                }
            },
        ))
        .expect("run mock react loop");

        assert!(pending_action.is_none());
        assert!(answer.contains("Java 进程"));
        assert_eq!(planner_calls, 3);

        let updated = state
            .ops_agent
            .get_conversation(&conversation.id)
            .expect("reload conversation");
        let tool_messages = updated
            .messages
            .iter()
            .filter(|item| item.role == OpsAgentRole::Tool)
            .collect::<Vec<_>>();
        assert_eq!(tool_messages.len(), 2);
        assert!(tool_messages[0].content.contains("metrics"));
        assert!(tool_messages[1].content.contains("process=java"));
    }

    #[test]
    fn react_loop_can_queue_mock_approval_action() {
        let mut registry = OpsAgentToolRegistry::new();
        registry.register(MockDangerTool);

        let state = test_state_with_registry(registry);
        let conversation = state
            .ops_agent
            .create_conversation(Some("approval"), None)
            .expect("create conversation");

        let (assistant_message, pending_action) = tauri::async_runtime::block_on(run_mock_react_loop(
            Arc::clone(&state),
            &conversation.id,
            None,
            "请直接清理历史日志目录",
            |_history, _current_user_message| PlannedAgentReply {
                reply: "该操作有风险，我先发起审批。".to_string(),
                tool: PlannedToolAction {
                    kind: OpsAgentToolKind::new("mock_danger"),
                    command: Some("rm -rf /var/log/old".to_string()),
                    reason: Some("cleanup requested by user".to_string()),
                },
            },
        ))
        .expect("run mock react loop");

        let action = pending_action.expect("approval action");
        assert_eq!(action.tool_kind, OpsAgentToolKind::new("mock_danger"));
        assert_eq!(action.status, OpsAgentActionStatus::Pending);
        assert!(assistant_message.contains("needs approval"));

        let resolved = tauri::async_runtime::block_on(resolve_pending_action(
            Arc::clone(&state),
            OpsAgentResolveActionInput {
                action_id: action.id.clone(),
                approve: true,
            },
        ))
        .expect("resolve pending action");

        assert_eq!(resolved.action.status, OpsAgentActionStatus::Executed);
        assert_eq!(
            resolved.action.execution_output.as_deref(),
            Some("mock danger executed")
        );
    }
}
