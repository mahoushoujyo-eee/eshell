use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::ssh_service;
use crate::state::AppState;

use super::openai;
use super::types::{
    OpsAgentActionStatus, OpsAgentChatAccepted, OpsAgentChatInput, OpsAgentConversation,
    OpsAgentConversationSummary, OpsAgentResolveActionInput, OpsAgentResolveActionResult,
    OpsAgentRole, OpsAgentStreamEvent, OpsAgentStreamStage, OpsAgentToolKind,
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
    state
        .ops_agent
        .append_message(&conversation.id, OpsAgentRole::User, &question, None)?;

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
        if let Err(err) = process_chat_stream(
            state_for_task,
            app_for_task.clone(),
            run_id_for_task.clone(),
            conversation_id_for_task.clone(),
            question,
            input.session_id,
        )
        .await
        {
            let mut event = OpsAgentStreamEvent::new(
                run_id_for_task,
                conversation_id_for_task,
                OpsAgentStreamStage::Error,
            );
            event.error = Some(err.to_string());
            let _ = app_for_task.emit("ops-agent-stream", event);
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
            "Write-shell action rejected.\nCommand: {}\nReason: {}",
            updated.command, updated.reason
        );
        let _ = state.ops_agent.append_message(
            &updated.conversation_id,
            OpsAgentRole::Assistant,
            &notice,
            Some(OpsAgentToolKind::WriteShell),
        );
        return Ok(OpsAgentResolveActionResult {
            action: updated,
            note: "Action rejected".to_string(),
        });
    }

    let Some(session_id) = action.session_id.clone() else {
        let updated = state
            .ops_agent
            .mark_action_failed(&input.action_id, "missing session id for write_shell".to_string())?;
        return Ok(OpsAgentResolveActionResult {
            action: updated,
            note: "Action failed: missing session id".to_string(),
        });
    };

    let command = action.command.clone();
    let state_for_exec = Arc::clone(&state);
    let exec_result = tauri::async_runtime::spawn_blocking(move || {
        ssh_service::execute_command(&state_for_exec, &session_id, &command)
    })
    .await
    .map_err(|err| AppError::Runtime(err.to_string()))?;

    match exec_result {
        Ok(execution) => {
            let output = format_execution_output(&execution.stdout, &execution.stderr, execution.exit_code);
            let updated = state
                .ops_agent
                .mark_action_executed(&input.action_id, output.clone(), execution.exit_code)?;
            let tool_message = format!(
                "write_shell executed.\nCommand: {}\nExit: {}\n{}",
                updated.command, execution.exit_code, output
            );
            let _ = state.ops_agent.append_message(
                &updated.conversation_id,
                OpsAgentRole::Tool,
                &tool_message,
                Some(OpsAgentToolKind::WriteShell),
            );

            Ok(OpsAgentResolveActionResult {
                action: updated,
                note: "Action approved and executed".to_string(),
            })
        }
        Err(err) => {
            let updated = state
                .ops_agent
                .mark_action_failed(&input.action_id, err.to_string())?;
            Ok(OpsAgentResolveActionResult {
                action: updated,
                note: "Action approved but execution failed".to_string(),
            })
        }
    }
}

async fn process_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    question: String,
    session_id: Option<String>,
) -> AppResult<()> {
    emit_event(
        &app,
        OpsAgentStreamEvent::new(run_id.clone(), conversation_id.clone(), OpsAgentStreamStage::Started),
    );

    let config = state.storage.get_ai_config();
    let history = state.ops_agent.get_conversation(&conversation_id)?.messages;
    let plan = openai::plan_reply(&config, &history, &question, session_id.as_deref()).await?;
    let planner_reply = plan.reply.clone();

    let mut pending_action = None;
    let assistant_answer = match plan.tool.kind {
        OpsAgentToolKind::None => normalized_reply(plan.reply, "收到，我来帮你处理这个运维问题。"),
        OpsAgentToolKind::ReadShell => {
            match (plan.tool.command.clone(), session_id.clone()) {
                (None, _) => normalized_reply(
                    planner_reply.clone(),
                    "我没有拿到可执行的 read_shell 命令，请补充需求后重试。",
                ),
                (_, None) => normalized_reply(
                    planner_reply.clone(),
                    "当前没有可用 SSH 会话，无法执行 read_shell 工具。",
                ),
                (Some(command), Some(session_id)) => {
                    let read_result =
                        execute_shell_command(Arc::clone(&state), session_id, command.clone()).await;
                    match read_result {
                        Ok(execution) => {
                            let output =
                                format_execution_output(&execution.stdout, &execution.stderr, execution.exit_code);
                            let tool_note = format!(
                                "read_shell executed.\nCommand: {}\nExit: {}\n{}",
                                command, execution.exit_code, output
                            );
                            let _ = state.ops_agent.append_message(
                                &conversation_id,
                                OpsAgentRole::Tool,
                                &tool_note,
                                Some(OpsAgentToolKind::ReadShell),
                            );

                            let mut tool_event = OpsAgentStreamEvent::new(
                                run_id.clone(),
                                conversation_id.clone(),
                                OpsAgentStreamStage::ToolRead,
                            );
                            tool_event.chunk = Some(format!("read_shell: {}", command));
                            emit_event(&app, tool_event);

                            let after_history = state.ops_agent.get_conversation(&conversation_id)?.messages;
                            openai::summarize_tool_result(
                                &config,
                                &after_history,
                                OpsAgentToolKind::ReadShell,
                                &command,
                                &output,
                                Some(execution.exit_code),
                            )
                            .await
                            .unwrap_or_else(|_| normalized_reply(planner_reply.clone(), "命令已执行，结果已返回。"))
                        }
                        Err(err) => {
                            normalized_reply(planner_reply.clone(), &format!("read_shell 执行失败：{}", err))
                        }
                    }
                }
            }
        }
        OpsAgentToolKind::WriteShell => {
            match plan.tool.command.clone() {
                None => normalized_reply(
                    planner_reply.clone(),
                    "我没有拿到可执行的 write_shell 命令，请补充需求后重试。",
                ),
                Some(command) => {
                    let action = state.ops_agent.create_pending_action(
                        &conversation_id,
                        session_id.as_deref(),
                        &command,
                        plan.tool.reason.as_deref().unwrap_or("requested by agent"),
                    )?;
                    pending_action = Some(action.clone());

                    let mut approve_event = OpsAgentStreamEvent::new(
                        run_id.clone(),
                        conversation_id.clone(),
                        OpsAgentStreamStage::RequiresApproval,
                    );
                    approve_event.pending_action = Some(action);
                    emit_event(&app, approve_event);

                    normalized_reply(
                        planner_reply,
                        "我生成了一个 write_shell 操作，已进入待确认队列。请在前端确认或拒绝后执行。",
                    )
                }
            }
        }
    };

    state.ops_agent.append_message(
        &conversation_id,
        OpsAgentRole::Assistant,
        &assistant_answer,
        None,
    )?;
    stream_text_response(&app, &run_id, &conversation_id, &assistant_answer);

    let mut completed = OpsAgentStreamEvent::new(run_id, conversation_id, OpsAgentStreamStage::Completed);
    completed.full_answer = Some(assistant_answer);
    completed.pending_action = pending_action;
    emit_event(&app, completed);

    Ok(())
}

async fn execute_shell_command(
    state: Arc<AppState>,
    session_id: String,
    command: String,
) -> AppResult<crate::models::CommandExecutionResult> {
    tauri::async_runtime::spawn_blocking(move || ssh_service::execute_command(&state, &session_id, &command))
        .await
        .map_err(|err| AppError::Runtime(err.to_string()))?
}

fn stream_text_response(app: &AppHandle, run_id: &str, conversation_id: &str, text: &str) {
    let chunks = split_stream_chunks(text, 36);
    for chunk in chunks {
        let mut delta = OpsAgentStreamEvent::new(
            run_id.to_string(),
            conversation_id.to_string(),
            OpsAgentStreamStage::Delta,
        );
        delta.chunk = Some(chunk);
        emit_event(app, delta);
    }
}

fn split_stream_chunks(text: &str, chunk_size: usize) -> Vec<String> {
    if text.is_empty() || chunk_size == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        current.push(ch);
        count += 1;
        if count >= chunk_size {
            out.push(current);
            current = String::new();
            count = 0;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn normalized_reply(reply: String, fallback: &str) -> String {
    if reply.trim().is_empty() {
        fallback.to_string()
    } else {
        reply
    }
}

fn format_execution_output(stdout: &str, stderr: &str, exit_code: i32) -> String {
    let mut sections = Vec::new();
    if !stdout.trim().is_empty() {
        sections.push(format!("stdout:\n{}", stdout.trim_end()));
    }
    if !stderr.trim().is_empty() {
        sections.push(format!("stderr:\n{}", stderr.trim_end()));
    }
    if sections.is_empty() {
        sections.push("<empty output>".to_string());
    }
    sections.push(format!("exitCode: {exit_code}"));
    sections.join("\n\n")
}

fn emit_event(app: &AppHandle, event: OpsAgentStreamEvent) {
    let _ = app.emit("ops-agent-stream", event);
}
