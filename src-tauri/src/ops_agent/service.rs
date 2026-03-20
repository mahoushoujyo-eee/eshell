use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::state::AppState;

use super::context::load_session_context;
use super::events::OpsAgentEventEmitter;
use super::openai;
use super::tools::{OpsAgentToolExecution, OpsAgentToolOutcome, OpsAgentToolResolveRequest};
use super::types::{
    OpsAgentActionStatus, OpsAgentChatAccepted, OpsAgentChatInput, OpsAgentConversation,
    OpsAgentConversationSummary, OpsAgentMessage, OpsAgentResolveActionInput,
    OpsAgentResolveActionResult, OpsAgentRole,
};

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

pub fn start_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    input: OpsAgentChatInput,
) -> AppResult<OpsAgentChatAccepted> {
    let question = input.question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::Validation("question cannot be empty".to_string()));
    }

    let conversation = state.ops_agent.ensure_conversation(
        input.conversation_id.as_deref(),
        &question,
        input.session_id.as_deref(),
    )?;
    let session_id = conversation.session_id.clone();
    let user_message = state.ops_agent.append_message(
        &conversation.id,
        OpsAgentRole::User,
        &question,
        None,
        input.shell_context,
    )?;

    let run_id = Uuid::new_v4().to_string();
    let accepted = OpsAgentChatAccepted {
        run_id: run_id.clone(),
        conversation_id: conversation.id.clone(),
        started_at: now_rfc3339(),
    };

    let state_for_task = Arc::clone(&state);
    let app_for_task = app.clone();
    let run_id_for_task = run_id.clone();
    let conversation_id_for_task = conversation.id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = process_chat_stream(
            state_for_task,
            app_for_task.clone(),
            run_id_for_task.clone(),
            conversation_id_for_task.clone(),
            session_id,
            user_message.id,
        )
        .await
        {
            OpsAgentEventEmitter::new(app_for_task, run_id_for_task, conversation_id_for_task)
                .error(error.to_string());
        }
    });

    Ok(accepted)
}

pub async fn resolve_pending_action(
    state: Arc<AppState>,
    input: OpsAgentResolveActionInput,
) -> AppResult<OpsAgentResolveActionResult> {
    let action = state.ops_agent.get_pending_action(&input.action_id)?;
    if action.status != OpsAgentActionStatus::Pending {
        return Err(AppError::Validation(
            "action is not pending and cannot be resolved again".to_string(),
        ));
    }

    if !input.approve {
        let updated = state.ops_agent.mark_action_rejected(&input.action_id)?;
        let notice = format!(
            "{} rejected.\nCommand: {}\nReason: {}",
            updated.tool_kind,
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
) -> AppResult<()> {
    let emitter = OpsAgentEventEmitter::new(app, run_id, conversation_id.clone());
    emitter.started();

    let config = state.storage.get_ai_config();
    let conversation = state.ops_agent.get_conversation(&conversation_id)?;
    let (history, current_user_message) =
        split_history_for_current_message(conversation.messages, &current_user_message_id)?;
    let session_context = load_session_context(&state, session_id.as_deref());
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let plan = openai::plan_reply(
        &config,
        &history,
        &current_user_message,
        &session_context,
        &tool_hints,
    )
    .await?;

    let mut pending_action = None;
    let assistant_answer = if plan.tool.kind.is_none() {
        stream_answer_with_fallback(
            &config,
            &history,
            &current_user_message,
            &session_context,
            Some(plan.reply.as_str()),
            &emitter,
        )
        .await?
    } else {
        let tool = state.ops_agent_tools.get(&plan.tool.kind).ok_or_else(|| {
            AppError::Validation(format!("tool {} is not registered", plan.tool.kind))
        })?;

        if let Some(command) = plan.tool.command.clone() {
            match tool
                .execute(super::tools::OpsAgentToolRequest {
                    state: Arc::clone(&state),
                    conversation_id: conversation_id.clone(),
                    session_id: session_id.clone(),
                    command,
                    reason: plan.tool.reason.clone(),
                })
                .await?
            {
                OpsAgentToolOutcome::Executed(execution) => {
                    let _ = state.ops_agent.append_message(
                        &conversation_id,
                        OpsAgentRole::Tool,
                        &execution.message,
                        Some(execution.tool_kind.clone()),
                        None,
                    );
                    if let Some(label) = execution.stream_label.clone() {
                        emitter.tool_read(label);
                    }

                    let after_history = state.ops_agent.get_conversation(&conversation_id)?.messages;
                    stream_tool_summary_with_fallback(
                        &config,
                        &after_history,
                        &session_context,
                        &execution,
                        Some(plan.reply.as_str()),
                        &emitter,
                    )
                    .await?
                }
                OpsAgentToolOutcome::AwaitingApproval(action) => {
                    pending_action = Some(action.clone());
                    emitter.requires_approval(action);
                    emit_static_reply(
                        normalized_reply(
                            plan.reply,
                            "A write_shell action was queued for approval. Approve or reject it in the UI.",
                        ),
                        &emitter,
                    )
                }
            }
        } else {
            emit_static_reply(
                normalized_reply(
                    plan.reply,
                    &format!("No executable command was returned for tool {}.", plan.tool.kind),
                ),
                &emitter,
            )
        }
    };

    state.ops_agent.append_message(
        &conversation_id,
        OpsAgentRole::Assistant,
        &assistant_answer,
        None,
        None,
    )?;
    emitter.completed(assistant_answer, pending_action);
    Ok(())
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
) -> AppResult<String> {
    match openai::stream_final_answer(
        config,
        history,
        current_message,
        session_context,
        planner_reply,
        |delta| {
            emitter.delta(delta.to_string());
            Ok(())
        },
    )
    .await
    {
        Ok(answer) => Ok(answer),
        Err(error) => {
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

async fn stream_tool_summary_with_fallback(
    config: &crate::models::AiConfig,
    history: &[super::types::OpsAgentMessage],
    session_context: &super::context::OpsAgentSessionContext,
    execution: &OpsAgentToolExecution,
    planner_reply: Option<&str>,
    emitter: &OpsAgentEventEmitter,
) -> AppResult<String> {
    match openai::stream_tool_summary(
        config,
        history,
        session_context,
        &execution.tool_kind,
        &execution.command,
        &execution.output,
        execution.exit_code,
        |delta| {
            emitter.delta(delta.to_string());
            Ok(())
        },
    )
    .await
    {
        Ok(answer) => Ok(answer),
        Err(error) => {
            let fallback = normalized_reply(
                planner_reply.unwrap_or_default().to_string(),
                "The command completed. Review the tool result above for details.",
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

fn normalized_reply(reply: String, fallback: &str) -> String {
    if reply.trim().is_empty() {
        fallback.to_string()
    } else {
        reply
    }
}
