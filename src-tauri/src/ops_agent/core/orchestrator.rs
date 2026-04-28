use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::AppHandle;
use tokio::time::sleep;

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;
use crate::ops_agent::core::agents::{
    ExecutorAgent, ExecutorAgentInput, PlannerAgent, PlannerAgentInput, ReviewerAgent,
    ReviewerAgentInput, ValidatorAgent, ValidatorAgentInput,
};
use crate::ops_agent::core::helpers::{ensure_run_not_cancelled, is_run_cancelled_error};
use crate::ops_agent::core::prompting::OpsAgentSessionContext;
use crate::ops_agent::domain::types::{
    OpsAgentExecutionReport, OpsAgentKind, OpsAgentMessage, OpsAgentPendingAction,
    OpsAgentReviewReport, OpsAgentRole, OpsAgentRunPhase, OpsAgentValidationReport,
    OpsAgentWorkflowPlan,
};
use crate::ops_agent::infrastructure::agent_trace_store::OpsAgentRunManifest;
use crate::ops_agent::infrastructure::logging::{
    append_debug_log, resolve_ops_agent_log_path, OpsAgentLogContext,
};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;

use super::agents::OpsSubAgent;
use super::ProcessChatOutcome;

const OPS_AGENT_AI_MAX_RETRIES: usize = 3;
const OPS_AGENT_AI_RETRY_DELAY_SECS: u64 = 3;
const OPS_AGENT_AI_RETRY_SLEEP_SLICE_MS: u64 = 200;

pub(crate) async fn process_chat_stream(
    state: Arc<AppState>,
    app: AppHandle,
    run_id: String,
    conversation_id: String,
    session_id: Option<String>,
    current_user_message_id: String,
    run_handle: OpsAgentRunHandle,
    seed_turn_tool_history: Vec<OpsAgentMessage>,
) -> AppResult<ProcessChatOutcome> {
    let emitter = OpsAgentEventEmitter::new(
        app,
        resolve_ops_agent_log_path(&state.storage.data_dir()),
        run_id.clone(),
        conversation_id.clone(),
    );
    emitter.started();
    create_trace_run(
        &state,
        &run_id,
        &conversation_id,
        session_id.clone(),
        &current_user_message_id,
    );
    trace_event(
        &state,
        &run_id,
        &conversation_id,
        None,
        Some(OpsAgentKind::Orchestrator),
        "run.started",
        "orchestrator run started",
    );

    append_debug_log(
        state.as_ref(),
        "orchestrator.run.started",
        Some(run_id.as_str()),
        Some(conversation_id.as_str()),
        format!(
            "session_id={} current_message_id={} seed_tool_messages={}",
            session_id.as_deref().unwrap_or("-"),
            current_user_message_id,
            seed_turn_tool_history.len()
        ),
    );
    ensure_run_not_cancelled(&run_handle)?;

    let config = state.storage.get_ai_config();
    if let Some(compaction) = super::compaction::auto_compact_conversation_if_needed(
        state.as_ref(),
        &conversation_id,
        session_id.as_deref(),
        &config,
    )
    .await?
    {
        append_debug_log(
            state.as_ref(),
            "orchestrator.auto_compact",
            Some(run_id.as_str()),
            Some(conversation_id.as_str()),
            format!(
                "estimated_before={} estimated_after={}",
                compaction.estimated_tokens_before, compaction.estimated_tokens_after
            ),
        );
    }

    let conversation = state.ops_agent.get_conversation(&conversation_id)?;
    let (history, current_user_message) =
        split_history_for_current_message(conversation.messages, &current_user_message_id)?;
    let session_context = super::prompting::load_session_context(&state, session_id.as_deref());
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let mut working_history = history.clone();
    if !seed_turn_tool_history.is_empty() {
        working_history.extend(seed_turn_tool_history.clone());
    }

    let plan = run_planner(
        Arc::clone(&state),
        &emitter,
        &run_handle,
        &run_id,
        &conversation_id,
        &config,
        &working_history,
        &current_user_message,
        &session_context,
        &tool_hints,
    )
    .await?;

    let executor_output = run_executor(
        Arc::clone(&state),
        &emitter,
        &run_handle,
        &run_id,
        &conversation_id,
        session_id.clone(),
        &current_user_message_id,
        &plan,
    )
    .await?;
    working_history.extend(executor_output.tool_history.clone());

    let review = run_reviewer(
        Arc::clone(&state),
        &emitter,
        &run_handle,
        &run_id,
        &conversation_id,
        &config,
        &plan,
        &executor_output.report,
    )
    .await?;

    let validation = run_validator(
        Arc::clone(&state),
        &emitter,
        &run_handle,
        &run_id,
        &conversation_id,
        &config,
        &plan,
        &executor_output.report,
        &review,
    )
    .await?;

    let answer_context =
        build_orchestrator_answer_context(&plan, &executor_output.report, &review, &validation);
    let answer = run_answering(
        state.as_ref(),
        &emitter,
        &run_handle,
        &run_id,
        &conversation_id,
        &config,
        &working_history,
        &current_user_message,
        &session_context,
        &answer_context,
    )
    .await?;
    trace_agent_io(
        state.as_ref(),
        &run_id,
        5,
        OpsAgentKind::Orchestrator,
        &json!({ "answerContext": answer_context }),
        &json!({ "answer": answer }),
    );
    emitter.agent_completed(
        OpsAgentRunPhase::Answering,
        OpsAgentKind::Orchestrator,
        "Answer ready",
        "Final response prepared",
    );

    finalize_chat_completion(
        &state,
        &conversation_id,
        answer,
        executor_output.report.pending_action,
        &emitter,
    )
}

async fn run_planner(
    state: Arc<AppState>,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_user_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[super::prompting::OpsAgentToolPromptHint],
) -> AppResult<OpsAgentWorkflowPlan> {
    let agent = PlannerAgent;
    let phase = agent.phase();
    let agent_kind = agent.kind();

    emitter.phase_changed(phase.clone(), agent_kind.clone(), "Planning task");
    emitter.agent_started(
        phase.clone(),
        agent_kind.clone(),
        "Planning task",
        "Creating a serial execution plan",
    );
    trace_event(
        &state,
        run_id,
        conversation_id,
        Some(phase.clone()),
        Some(agent_kind.clone()),
        "agent.started",
        "planner started",
    );

    let input = PlannerAgentInput {
        state: Arc::clone(&state),
        run_id: run_id.to_string(),
        conversation_id: conversation_id.to_string(),
        config: config.clone(),
        history: history.to_vec(),
        current_message: current_user_message.clone(),
        session_context: session_context.clone(),
        tool_hints: tool_hints.to_vec(),
    };
    let trace_request = json!({
        "history": history,
        "currentMessage": current_user_message,
        "sessionContext": {
            "sessionId": session_context.session_id.as_deref(),
            "currentDir": session_context.current_dir.as_deref(),
            "lastOutputPreview": session_context.last_output_preview.as_deref(),
        },
        "toolHints": tool_hints.iter().map(|item| {
            json!({
                "kind": item.kind.to_string(),
                "description": item.description.as_str(),
                "usageNotes": &item.usage_notes,
                "requiresApproval": item.requires_approval,
            })
        }).collect::<Vec<_>>(),
    });
    let plan = execute_ai_agent_with_retry(
        state.as_ref(),
        emitter,
        run_handle,
        run_id,
        conversation_id,
        phase.clone(),
        agent_kind.clone(),
        "Planning task",
        || agent.run(input_clone_planner(&input)),
    )
    .await?;
    trace_agent_io(&state, run_id, 1, agent_kind.clone(), &trace_request, &plan);
    emitter.agent_completed(
        phase,
        agent_kind,
        "Plan ready",
        if plan.summary.trim().is_empty() {
            format!("{} step(s)", plan.steps.len())
        } else {
            plan.summary.clone()
        },
    );
    Ok(plan)
}

async fn run_executor(
    state: Arc<AppState>,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    session_id: Option<String>,
    current_user_message_id: &str,
    plan: &OpsAgentWorkflowPlan,
) -> AppResult<super::agents::ExecutorAgentOutput> {
    let agent = ExecutorAgent;
    let phase = agent.phase();
    let agent_kind = agent.kind();

    emitter.phase_changed(phase.clone(), agent_kind.clone(), "Executing plan");
    emitter.agent_started(
        phase.clone(),
        agent_kind.clone(),
        "Executing plan",
        plan.summary.clone(),
    );
    trace_event(
        &state,
        run_id,
        conversation_id,
        Some(phase.clone()),
        Some(agent_kind.clone()),
        "agent.started",
        "executor started",
    );

    let input = ExecutorAgentInput {
        state: Arc::clone(&state),
        emitter: emitter.clone(),
        run_handle: run_handle.clone(),
        conversation_id: conversation_id.to_string(),
        session_id,
        current_user_message_id: current_user_message_id.to_string(),
        plan: plan.clone(),
    };

    let output = agent.run(input).await?;
    trace_agent_io(&state, run_id, 2, agent_kind.clone(), plan, &output.report);
    let completed_message = if output.report.pending_action.is_some() {
        "Execution paused for approval".to_string()
    } else {
        output.report.summary.clone()
    };
    emitter.agent_completed(phase, agent_kind, "Execution complete", completed_message);
    Ok(output)
}

async fn run_reviewer(
    state: Arc<AppState>,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    config: &AiConfig,
    plan: &OpsAgentWorkflowPlan,
    execution: &OpsAgentExecutionReport,
) -> AppResult<OpsAgentReviewReport> {
    let agent = ReviewerAgent;
    let phase = agent.phase();
    let agent_kind = agent.kind();

    emitter.phase_changed(phase.clone(), agent_kind.clone(), "Reviewing execution");
    emitter.agent_started(
        phase.clone(),
        agent_kind.clone(),
        "Reviewing execution",
        "Checking execution result and gaps",
    );
    trace_event(
        &state,
        run_id,
        conversation_id,
        Some(phase.clone()),
        Some(agent_kind.clone()),
        "agent.started",
        "reviewer started",
    );

    let input = ReviewerAgentInput {
        state: Arc::clone(&state),
        run_id: run_id.to_string(),
        conversation_id: conversation_id.to_string(),
        config: config.clone(),
        plan: plan.clone(),
        execution: execution.clone(),
    };
    let trace_request = json!({
        "plan": plan,
        "execution": execution,
    });
    let review = execute_ai_agent_with_retry(
        state.as_ref(),
        emitter,
        run_handle,
        run_id,
        conversation_id,
        phase.clone(),
        agent_kind.clone(),
        "Reviewing execution",
        || agent.run(input_clone_reviewer(&input)),
    )
    .await?;
    trace_agent_io(
        &state,
        run_id,
        3,
        agent_kind.clone(),
        &trace_request,
        &review,
    );
    emitter.agent_completed(phase, agent_kind, "Review complete", review.summary.clone());
    Ok(review)
}

async fn run_validator(
    state: Arc<AppState>,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    config: &AiConfig,
    plan: &OpsAgentWorkflowPlan,
    execution: &OpsAgentExecutionReport,
    review: &OpsAgentReviewReport,
) -> AppResult<OpsAgentValidationReport> {
    let agent = ValidatorAgent;
    let phase = agent.phase();
    let agent_kind = agent.kind();

    emitter.phase_changed(phase.clone(), agent_kind.clone(), "Validating completion");
    emitter.agent_started(
        phase.clone(),
        agent_kind.clone(),
        "Validating completion",
        "Checking whether the task is actually complete",
    );
    trace_event(
        &state,
        run_id,
        conversation_id,
        Some(phase.clone()),
        Some(agent_kind.clone()),
        "agent.started",
        "validator started",
    );

    let input = ValidatorAgentInput {
        state: Arc::clone(&state),
        run_id: run_id.to_string(),
        conversation_id: conversation_id.to_string(),
        config: config.clone(),
        plan: plan.clone(),
        execution: execution.clone(),
        review: review.clone(),
    };
    let trace_request = json!({
        "plan": plan,
        "execution": execution,
        "review": review,
    });
    let validation = execute_ai_agent_with_retry(
        state.as_ref(),
        emitter,
        run_handle,
        run_id,
        conversation_id,
        phase.clone(),
        agent_kind.clone(),
        "Validating completion",
        || agent.run(input_clone_validator(&input)),
    )
    .await?;
    trace_agent_io(
        &state,
        run_id,
        4,
        agent_kind.clone(),
        &trace_request,
        &validation,
    );
    emitter.agent_completed(
        phase,
        agent_kind,
        if validation.completed {
            "Validation passed"
        } else {
            "Validation found gaps"
        },
        validation.summary.clone(),
    );
    Ok(validation)
}

async fn run_answering(
    state: &AppState,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_user_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    answer_context: &str,
) -> AppResult<String> {
    emitter.phase_changed(
        OpsAgentRunPhase::Answering,
        OpsAgentKind::Orchestrator,
        "Answering user",
    );
    emitter.agent_started(
        OpsAgentRunPhase::Answering,
        OpsAgentKind::Orchestrator,
        "Answering user",
        "Preparing final response",
    );
    execute_ai_agent_with_retry(
        state,
        emitter,
        run_handle,
        run_id,
        conversation_id,
        OpsAgentRunPhase::Answering,
        OpsAgentKind::Orchestrator,
        "Answering user",
        || {
            super::llm::stream_final_answer(
                state,
                config,
                history,
                current_user_message,
                session_context,
                Some(answer_context),
                Some(OpsAgentLogContext::new(
                    state,
                    Some(run_id),
                    Some(conversation_id),
                )),
                |delta| {
                    ensure_run_not_cancelled(run_handle)?;
                    emitter.delta(delta.to_string());
                    Ok(())
                },
            )
        },
    )
    .await
}

async fn execute_ai_agent_with_retry<T, F, Fut>(
    state: &AppState,
    emitter: &OpsAgentEventEmitter,
    run_handle: &OpsAgentRunHandle,
    run_id: &str,
    conversation_id: &str,
    phase: OpsAgentRunPhase,
    agent_kind: OpsAgentKind,
    title: &str,
    mut operation: F,
) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    for attempt in 0..=OPS_AGENT_AI_MAX_RETRIES {
        ensure_run_not_cancelled(run_handle)?;
        let started_at = Instant::now();
        append_debug_log(
            state,
            "orchestrator.agent.request_start",
            Some(run_id),
            Some(conversation_id),
            format!(
                "agent={} phase={} attempt={}/{}",
                agent_kind,
                phase,
                attempt + 1,
                OPS_AGENT_AI_MAX_RETRIES + 1
            ),
        );

        match operation().await {
            Ok(value) => {
                append_debug_log(
                    state,
                    "orchestrator.agent.request_done",
                    Some(run_id),
                    Some(conversation_id),
                    format!(
                        "agent={} phase={} attempt={}/{} elapsed_ms={}",
                        agent_kind,
                        phase,
                        attempt + 1,
                        OPS_AGENT_AI_MAX_RETRIES + 1,
                        started_at.elapsed().as_millis()
                    ),
                );
                return Ok(value);
            }
            Err(error) if is_run_cancelled_error(&error) => return Err(error),
            Err(error) => {
                let retryable = is_retryable_ai_error(&error);
                append_debug_log(
                    state,
                    "orchestrator.agent.request_failed",
                    Some(run_id),
                    Some(conversation_id),
                    format!(
                        "agent={} phase={} attempt={}/{} elapsed_ms={} retryable={} error={}",
                        agent_kind,
                        phase,
                        attempt + 1,
                        OPS_AGENT_AI_MAX_RETRIES + 1,
                        started_at.elapsed().as_millis(),
                        retryable,
                        error
                    ),
                );
                if !retryable || attempt >= OPS_AGENT_AI_MAX_RETRIES {
                    return Err(error);
                }

                emitter.agent_progress(
                    phase.clone(),
                    agent_kind.clone(),
                    title.to_string(),
                    format!(
                        "AI request failed; retrying in {OPS_AGENT_AI_RETRY_DELAY_SECS}s ({}/{OPS_AGENT_AI_MAX_RETRIES})",
                        attempt + 1
                    ),
                    None,
                    None,
                );
                wait_for_ai_retry_delay(run_handle).await?;
            }
        }
    }

    Err(AppError::Runtime(
        "AI retry loop exited unexpectedly".to_string(),
    ))
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
        Vec::new(),
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

fn build_orchestrator_answer_context(
    plan: &OpsAgentWorkflowPlan,
    execution: &OpsAgentExecutionReport,
    review: &OpsAgentReviewReport,
    validation: &OpsAgentValidationReport,
) -> String {
    format!(
        "Orchestrator context for final answer.\n\
Planner summary: {}\n\
Plan steps: {}\n\
Execution summary: {}\n\
Reviewer summary: {}\n\
Reviewer concerns: {}\n\
Validator completed: {}\n\
Validator confidence: {:.2}\n\
Validator summary: {}\n\
Validator evidence: {}\n\
Validator missing items: {}\n\
Pending approval: {}\n\n\
Write the final user-facing answer. Mention pending approval or incomplete validation clearly when present.",
        plan.summary,
        plan.steps
            .iter()
            .map(|step| format!(
                "{}{}",
                step.title,
                step.command
                    .as_ref()
                    .map(|command| format!(" ({command})"))
                    .unwrap_or_default()
            ))
            .collect::<Vec<_>>()
            .join("; "),
        execution.summary,
        review.summary,
        review.concerns.join("; "),
        validation.completed,
        validation.confidence,
        validation.summary,
        validation.evidence.join("; "),
        validation.missing_items.join("; "),
        execution
            .pending_action
            .as_ref()
            .map(|action| format!("{} {}", action.id, action.command))
            .unwrap_or_else(|| "none".to_string()),
    )
}

fn create_trace_run(
    state: &AppState,
    run_id: &str,
    conversation_id: &str,
    session_id: Option<String>,
    source_user_message_id: &str,
) {
    let manifest = OpsAgentRunManifest {
        run_id: run_id.to_string(),
        conversation_id: conversation_id.to_string(),
        session_id,
        source_user_message_id: source_user_message_id.to_string(),
        created_at: crate::models::now_rfc3339(),
    };
    if let Err(error) = state.ops_agent_traces.create_run(&manifest) {
        append_debug_log(
            state,
            "orchestrator.trace.create_failed",
            Some(run_id),
            Some(conversation_id),
            error.to_string(),
        );
    }
}

fn trace_event(
    state: &AppState,
    run_id: &str,
    conversation_id: &str,
    phase: Option<OpsAgentRunPhase>,
    agent_kind: Option<OpsAgentKind>,
    event: &str,
    message: &str,
) {
    if let Err(error) = state.ops_agent_traces.trace_event(
        run_id,
        conversation_id,
        phase,
        agent_kind,
        event,
        message,
    ) {
        append_debug_log(
            state,
            "orchestrator.trace.event_failed",
            Some(run_id),
            Some(conversation_id),
            error.to_string(),
        );
    }
}

fn trace_agent_io<T, U>(
    state: &AppState,
    run_id: &str,
    sequence: usize,
    agent_kind: OpsAgentKind,
    request: &T,
    response: &U,
) where
    T: serde::Serialize,
    U: serde::Serialize,
{
    if let Err(error) = state.ops_agent_traces.write_agent_io(
        run_id,
        sequence,
        agent_kind.clone(),
        request,
        response,
    ) {
        append_debug_log(
            state,
            "orchestrator.trace.agent_io_failed",
            Some(run_id),
            None,
            format!("agent={} error={error}", agent_kind),
        );
    }
}

fn input_clone_planner(input: &PlannerAgentInput) -> PlannerAgentInput {
    PlannerAgentInput {
        state: Arc::clone(&input.state),
        run_id: input.run_id.clone(),
        conversation_id: input.conversation_id.clone(),
        config: input.config.clone(),
        history: input.history.clone(),
        current_message: input.current_message.clone(),
        session_context: input.session_context.clone(),
        tool_hints: input.tool_hints.clone(),
    }
}

fn input_clone_reviewer(input: &ReviewerAgentInput) -> ReviewerAgentInput {
    ReviewerAgentInput {
        state: Arc::clone(&input.state),
        run_id: input.run_id.clone(),
        conversation_id: input.conversation_id.clone(),
        config: input.config.clone(),
        plan: input.plan.clone(),
        execution: input.execution.clone(),
    }
}

fn input_clone_validator(input: &ValidatorAgentInput) -> ValidatorAgentInput {
    ValidatorAgentInput {
        state: Arc::clone(&input.state),
        run_id: input.run_id.clone(),
        conversation_id: input.conversation_id.clone(),
        config: input.config.clone(),
        plan: input.plan.clone(),
        execution: input.execution.clone(),
        review: input.review.clone(),
    }
}

fn is_retryable_ai_error(error: &AppError) -> bool {
    match error {
        AppError::Reqwest(_) => true,
        AppError::Runtime(message) => {
            if let Some(status_code) = extract_status_code(message) {
                return status_code == 408
                    || status_code == 409
                    || status_code == 425
                    || status_code == 429
                    || status_code >= 500;
            }

            let normalized = message.to_ascii_lowercase();
            normalized.contains("timed out")
                || normalized.contains("timeout")
                || normalized.contains("connection reset")
                || normalized.contains("connection closed")
                || normalized.contains("error sending request")
                || normalized.contains("temporarily unavailable")
        }
        _ => false,
    }
}

fn extract_status_code(message: &str) -> Option<u16> {
    let marker = "status=";
    let start = message.find(marker)? + marker.len();
    let digits = message[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u16>().ok()
}

async fn wait_for_ai_retry_delay(run_handle: &OpsAgentRunHandle) -> AppResult<()> {
    let total = Duration::from_secs(OPS_AGENT_AI_RETRY_DELAY_SECS);
    let slice = Duration::from_millis(OPS_AGENT_AI_RETRY_SLEEP_SLICE_MS);
    let mut elapsed = Duration::ZERO;

    while elapsed < total {
        ensure_run_not_cancelled(run_handle)?;
        let next_slice = std::cmp::min(slice, total.saturating_sub(elapsed));
        sleep(next_slice).await;
        elapsed += next_slice;
    }

    ensure_run_not_cancelled(run_handle)
}
