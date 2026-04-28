use std::sync::Arc;
use std::time::Instant;

use uuid::Uuid;

use crate::ops_agent::core::helpers::{ensure_run_not_cancelled, truncate_for_log};
use crate::ops_agent::domain::types::{
    OpsAgentActionStatus, OpsAgentExecutionReport, OpsAgentExecutionStep, OpsAgentExecutorResume,
    OpsAgentExecutorResumeContext, OpsAgentKind, OpsAgentMessage, OpsAgentPendingAction,
    OpsAgentPlanStepStatus, OpsAgentRole, OpsAgentRunPhase, OpsAgentToolCall,
    OpsAgentToolCallStatus, OpsAgentWorkflowPlan,
};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::tools::{OpsAgentToolOutcome, OpsAgentToolRequest};
use crate::ops_agent::transport::events::OpsAgentEventEmitter;
use crate::state::AppState;

use super::{AgentFuture, OpsSubAgent};

const EXECUTOR_OUTPUT_PREVIEW_CHARS: usize = 1200;

pub struct ExecutorAgent;

pub struct ExecutorAgentInput {
    pub state: Arc<AppState>,
    pub emitter: OpsAgentEventEmitter,
    pub run_handle: OpsAgentRunHandle,
    pub conversation_id: String,
    pub session_id: Option<String>,
    pub current_user_message_id: String,
    pub plan: OpsAgentWorkflowPlan,
    pub resume: Option<OpsAgentExecutorResume>,
}

pub struct ExecutorAgentOutput {
    pub report: OpsAgentExecutionReport,
    pub tool_history: Vec<OpsAgentMessage>,
}

impl OpsSubAgent for ExecutorAgent {
    type Input = ExecutorAgentInput;
    type Output = ExecutorAgentOutput;

    fn kind(&self) -> OpsAgentKind {
        OpsAgentKind::Executor
    }

    fn phase(&self) -> OpsAgentRunPhase {
        OpsAgentRunPhase::Executing
    }

    fn run(&self, input: Self::Input) -> AgentFuture<Self::Output> {
        Box::pin(async move { execute_plan(input).await })
    }
}

async fn execute_plan(input: ExecutorAgentInput) -> crate::error::AppResult<ExecutorAgentOutput> {
    let resume = input.resume.clone();
    let mut report_steps = resume
        .as_ref()
        .map(|resume| resume.context.execution_steps.clone())
        .unwrap_or_default();
    if let Some(resume) = resume.as_ref() {
        apply_resolved_action_to_report_steps(
            &mut report_steps,
            &resume.context.pending_step_id,
            Some(&resume.resolved_action),
        );
    }
    let start_index = resume
        .as_ref()
        .and_then(|resume| {
            input
                .plan
                .steps
                .iter()
                .position(|step| step.id == resume.context.pending_step_id)
        })
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut tool_history = Vec::new();
    let executable_steps = input
        .plan
        .steps
        .iter()
        .filter(|step| step.tool_kind.is_some())
        .count();

    if input.plan.steps.is_empty() {
        return Ok(ExecutorAgentOutput {
            report: OpsAgentExecutionReport {
                summary: "No executor steps were needed.".to_string(),
                steps: Vec::new(),
                pending_action: None,
            },
            tool_history,
        });
    }

    let mut executed_tools = 0usize;
    for (index, step) in input.plan.steps.iter().enumerate().skip(start_index) {
        ensure_run_not_cancelled(&input.run_handle)?;
        let step_index = index + 1;
        let step_title = if step.title.trim().is_empty() {
            format!("Step {step_index}")
        } else {
            step.title.clone()
        };

        let Some(tool_kind) = step.tool_kind.clone() else {
            report_steps.push(OpsAgentExecutionStep {
                step_id: step.id.clone(),
                title: step_title.clone(),
                status: OpsAgentPlanStepStatus::Skipped,
                tool_kind: None,
                command: None,
                message: "Reasoning-only plan step; no tool execution required.".to_string(),
                output_preview: None,
                exit_code: None,
            });
            continue;
        };

        executed_tools += 1;
        input.emitter.agent_progress(
            OpsAgentRunPhase::Executing,
            OpsAgentKind::Executor,
            step_title.clone(),
            step.command.as_deref().unwrap_or("Preparing tool call"),
            Some(executed_tools),
            Some(executable_steps.max(1)),
        );

        let Some(command) = step
            .command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
        else {
            report_steps.push(OpsAgentExecutionStep {
                step_id: step.id.clone(),
                title: step_title,
                status: OpsAgentPlanStepStatus::Failed,
                tool_kind: Some(tool_kind),
                command: None,
                message: "Planner selected a tool without a command.".to_string(),
                output_preview: None,
                exit_code: None,
            });
            break;
        };

        let tool = match input.state.ops_agent_tools.get(&tool_kind) {
            Some(tool) => tool,
            None => {
                report_steps.push(OpsAgentExecutionStep {
                    step_id: step.id.clone(),
                    title: step_title,
                    status: OpsAgentPlanStepStatus::Failed,
                    tool_kind: Some(tool_kind.clone()),
                    command: Some(command.clone()),
                    message: format!("Tool {tool_kind} is not registered."),
                    output_preview: None,
                    exit_code: None,
                });
                break;
            }
        };

        let tool_call_id = Uuid::new_v4().to_string();
        input.emitter.tool_call(OpsAgentToolCall {
            id: tool_call_id.clone(),
            tool_kind: tool_kind.clone(),
            command: command.clone(),
            reason: normalize_optional_string(step.reason.as_str()),
            status: OpsAgentToolCallStatus::Requested,
            label: Some(step_title.clone()),
        });

        let started_at = Instant::now();
        let outcome = tool
            .execute(OpsAgentToolRequest {
                state: Arc::clone(&input.state),
                conversation_id: input.conversation_id.clone(),
                current_user_message_id: Some(input.current_user_message_id.clone()),
                session_id: input.session_id.clone(),
                command: command.clone(),
                reason: normalize_optional_string(step.reason.as_str()),
            })
            .await;

        let elapsed_ms = started_at.elapsed().as_millis();
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                report_steps.push(OpsAgentExecutionStep {
                    step_id: step.id.clone(),
                    title: step_title,
                    status: OpsAgentPlanStepStatus::Failed,
                    tool_kind: Some(tool_kind),
                    command: Some(command),
                    message: format!("Tool execution failed after {elapsed_ms}ms: {error}"),
                    output_preview: None,
                    exit_code: None,
                });
                break;
            }
        };

        match outcome {
            OpsAgentToolOutcome::Executed(execution) => {
                ensure_run_not_cancelled(&input.run_handle)?;
                let tool_message = input.state.ops_agent.append_message(
                    &input.conversation_id,
                    OpsAgentRole::Tool,
                    &execution.message,
                    Some(execution.tool_kind.clone()),
                    None,
                    Vec::new(),
                )?;
                tool_history.push(tool_message);

                let label = execution
                    .stream_label
                    .clone()
                    .unwrap_or_else(|| format!("{}: {}", execution.tool_kind, execution.command));
                input.emitter.tool_read(
                    label.clone(),
                    Some(OpsAgentToolCall {
                        id: tool_call_id,
                        tool_kind: execution.tool_kind.clone(),
                        command: execution.command.clone(),
                        reason: normalize_optional_string(step.reason.as_str()),
                        status: OpsAgentToolCallStatus::Executed,
                        label: Some(label),
                    }),
                );

                report_steps.push(OpsAgentExecutionStep {
                    step_id: step.id.clone(),
                    title: step_title,
                    status: OpsAgentPlanStepStatus::Executed,
                    tool_kind: Some(execution.tool_kind),
                    command: Some(execution.command),
                    message: format!("Executed in {elapsed_ms}ms."),
                    output_preview: Some(truncate_for_log(
                        execution.output.as_str(),
                        EXECUTOR_OUTPUT_PREVIEW_CHARS,
                    )),
                    exit_code: execution.exit_code,
                });
            }
            OpsAgentToolOutcome::AwaitingApproval(action) => {
                report_steps.push(OpsAgentExecutionStep {
                    step_id: step.id.clone(),
                    title: step_title,
                    status: OpsAgentPlanStepStatus::AwaitingApproval,
                    tool_kind: Some(action.tool_kind.clone()),
                    command: Some(action.command.clone()),
                    message: format!(
                        "Execution paused for approval request {} after {elapsed_ms}ms.",
                        action.id
                    ),
                    output_preview: None,
                    exit_code: None,
                });
                let action = input.state.ops_agent.set_action_resume_context(
                    &action.id,
                    OpsAgentExecutorResumeContext {
                        plan: input.plan.clone(),
                        execution_steps: report_steps.clone(),
                        pending_step_id: step.id.clone(),
                    },
                )?;
                input.emitter.requires_approval(
                    action.clone(),
                    Some(OpsAgentToolCall {
                        id: tool_call_id,
                        tool_kind: action.tool_kind.clone(),
                        command: action.command.clone(),
                        reason: Some(action.reason.clone()),
                        status: OpsAgentToolCallStatus::AwaitingApproval,
                        label: Some("awaiting approval".to_string()),
                    }),
                );

                return Ok(ExecutorAgentOutput {
                    report: OpsAgentExecutionReport {
                        summary: "Execution paused because a tool action requires approval."
                            .to_string(),
                        steps: report_steps,
                        pending_action: Some(action),
                    },
                    tool_history,
                });
            }
        }
    }

    let summary = summarize_execution_steps(&report_steps);
    Ok(ExecutorAgentOutput {
        report: OpsAgentExecutionReport {
            summary,
            steps: report_steps,
            pending_action: None,
        },
        tool_history,
    })
}

fn apply_resolved_action_to_report_steps(
    report_steps: &mut [OpsAgentExecutionStep],
    pending_step_id: &str,
    action: Option<&OpsAgentPendingAction>,
) {
    let Some(action) = action else {
        return;
    };
    let Some(step) = report_steps
        .iter_mut()
        .find(|step| step.step_id == pending_step_id)
    else {
        return;
    };

    step.status = match action.status {
        OpsAgentActionStatus::Executed => OpsAgentPlanStepStatus::Executed,
        OpsAgentActionStatus::Rejected => OpsAgentPlanStepStatus::Rejected,
        OpsAgentActionStatus::Failed => OpsAgentPlanStepStatus::Failed,
        OpsAgentActionStatus::Pending => OpsAgentPlanStepStatus::AwaitingApproval,
    };
    step.message = match action.status {
        OpsAgentActionStatus::Executed => "Approved action executed before resume.".to_string(),
        OpsAgentActionStatus::Rejected => "Action was rejected before resume.".to_string(),
        OpsAgentActionStatus::Failed => "Approved action failed before resume.".to_string(),
        OpsAgentActionStatus::Pending => "Action is still awaiting approval.".to_string(),
    };
    step.output_preview = action
        .execution_output
        .as_deref()
        .map(|output| truncate_for_log(output, EXECUTOR_OUTPUT_PREVIEW_CHARS));
    step.exit_code = action.execution_exit_code;
}

fn summarize_execution_steps(steps: &[OpsAgentExecutionStep]) -> String {
    if steps.is_empty() {
        return "No executor steps were needed.".to_string();
    }

    if steps
        .iter()
        .any(|step| step.status == OpsAgentPlanStepStatus::Failed)
    {
        return "Execution stopped after a failed step.".to_string();
    }

    let executed = steps
        .iter()
        .filter(|step| step.status == OpsAgentPlanStepStatus::Executed)
        .count();
    if executed == 0 {
        "Plan contained no executable tool steps.".to_string()
    } else {
        format!("Executed {executed} tool step(s).")
    }
}

fn normalize_optional_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
