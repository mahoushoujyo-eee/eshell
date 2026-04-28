use std::collections::HashSet;
use std::time::Duration;

use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;
use crate::state::AppState;

use super::prompting::{
    build_answer_system_prompt, build_tool_summary_prompt, format_tool_result_user_message,
    OpsAgentSessionContext, OpsAgentToolPromptHint,
};
use crate::ops_agent::domain::types::{
    OpsAgentExecutionReport, OpsAgentMessage, OpsAgentReviewReport, OpsAgentRole, OpsAgentToolKind,
    OpsAgentValidationReport, OpsAgentWorkflowPlan,
};
use crate::ops_agent::infrastructure::logging::{truncate_for_log, OpsAgentLogContext};
use crate::ops_agent::providers::{
    normalize_tool_kind_alias, request_message, stream_message, ProviderChatMessage,
    ProviderChatMessageContent, ProviderChatMessageResponse, ProviderChatRequestOptions,
    ProviderImageUrlPart, ProviderMessageContentPart, ProviderToolChoice, ProviderToolDefinition,
};

const OPS_AGENT_AI_PLAN_TIMEOUT_SECS: u64 = 45;
const OPS_AGENT_AI_STREAM_TIMEOUT_SECS: u64 = 240;
const AI_LOG_MESSAGE_PREVIEW_CHARS: usize = 280;
const AI_LOG_ARGUMENT_PREVIEW_CHARS: usize = 220;
const AI_LOG_LAST_OUTPUT_PREVIEW_CHARS: usize = 180;

pub async fn stream_final_answer<F>(
    state: &AppState,
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    planner_reply: Option<&str>,
    log_context: Option<OpsAgentLogContext<'_>>,
    on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    validate_ai_config(config)?;
    log_request_context(
        log_context,
        "ai.answer",
        config,
        history,
        current_message,
        session_context,
        planner_reply,
        None,
    );

    let mut messages = Vec::new();
    messages.push(ProviderChatMessage {
        role: "system".to_string(),
        content: ProviderChatMessageContent::text(build_answer_system_prompt(
            &config.system_prompt,
            session_context,
            planner_reply,
        )),
    });
    for message in history {
        messages.push(convert_history_message(state, message)?);
    }
    messages.push(convert_history_message(state, current_message)?);

    stream_message(
        config,
        messages,
        ProviderChatRequestOptions::default(),
        Duration::from_secs(OPS_AGENT_AI_STREAM_TIMEOUT_SECS),
        log_context,
        "answer",
        on_delta,
    )
    .await
}

pub async fn compact_history_summary(
    config: &AiConfig,
    transcript: &str,
    target_max_tokens: u32,
    log_context: Option<OpsAgentLogContext<'_>>,
) -> AppResult<String> {
    validate_ai_config(config)?;
    if let Some(log_context) = log_context {
        log_context.append(
            "compact.ai_summary.request",
            format!(
                "model={} target_max_tokens={} transcript_chars={} transcript_preview={}",
                config.model,
                target_max_tokens,
                transcript.chars().count(),
                truncate_for_log(transcript, AI_LOG_MESSAGE_PREVIEW_CHARS)
            ),
        );
    }

    let summary_config = AiConfig {
        max_tokens: target_max_tokens.max(256),
        ..config.clone()
    };
    let messages = vec![
        ProviderChatMessage {
            role: "system".to_string(),
            content: ProviderChatMessageContent::text("You compress prior ops troubleshooting conversations so the session can continue inside a limited context window.\nSummarize only durable information that should survive compaction:\n- user goals and constraints\n- important environment facts, hosts, file paths, and config values\n- diagnoses, findings, and failed or successful actions\n- pending approvals, open questions, and next steps\nKeep it concise and structured in markdown bullets. Do not repeat low-signal chatter or verbatim logs.".to_string()),
        },
        ProviderChatMessage {
            role: "user".to_string(),
            content: ProviderChatMessageContent::text(format!(
                "Compress the following earlier conversation history into a compact summary for future turns:\n\n{transcript}"
            )),
        },
    ];

    request_text_completion(
        &summary_config,
        messages,
        Duration::from_secs(OPS_AGENT_AI_PLAN_TIMEOUT_SECS),
        log_context,
        "compact_summary",
    )
    .await
}

pub async fn plan_workflow(
    state: &AppState,
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[OpsAgentToolPromptHint],
    log_context: Option<OpsAgentLogContext<'_>>,
) -> AppResult<OpsAgentWorkflowPlan> {
    validate_ai_config(config)?;
    log_request_context(
        log_context,
        "ai.workflow_plan",
        config,
        history,
        current_message,
        session_context,
        None,
        Some(tool_hints),
    );

    let mut messages = Vec::new();
    messages.push(ProviderChatMessage {
        role: "system".to_string(),
        content: ProviderChatMessageContent::text(build_workflow_planner_prompt(
            &config.system_prompt,
            session_context,
            tool_hints,
        )),
    });
    for message in history {
        messages.push(convert_history_message(state, message)?);
    }
    messages.push(convert_history_message(state, current_message)?);

    let response = request_message(
        config,
        messages,
        ProviderChatRequestOptions {
            tools: vec![build_submit_plan_tool_definition(tool_hints)],
            tool_choice: Some(ProviderToolChoice::Named("submit_plan".to_string())),
            response_format: None,
            stream: false,
        },
        Duration::from_secs(OPS_AGENT_AI_PLAN_TIMEOUT_SECS),
        log_context,
        "workflow_plan",
    )
    .await?;
    log_provider_response(
        log_context,
        "ai.workflow_plan.provider_response",
        "ai.workflow_plan.provider_tool_call",
        &response,
    );

    parse_workflow_plan_from_response(&response, tool_hints).map(|plan| {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.workflow_plan.parsed",
                format!(
                    "summary={} steps={} success_criteria={}",
                    truncate_for_log(plan.summary.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
                    plan.steps.len(),
                    plan.success_criteria.len()
                ),
            );
        }
        plan
    })
}

pub async fn review_execution(
    config: &AiConfig,
    plan: &OpsAgentWorkflowPlan,
    execution: &OpsAgentExecutionReport,
    log_context: Option<OpsAgentLogContext<'_>>,
) -> AppResult<OpsAgentReviewReport> {
    validate_ai_config(config)?;
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.review.context",
            format!(
                "plan_steps={} execution_steps={} pending_action={}",
                plan.steps.len(),
                execution.steps.len(),
                execution.pending_action.is_some()
            ),
        );
    }

    let messages = vec![
        ProviderChatMessage {
            role: "system".to_string(),
            content: ProviderChatMessageContent::text(build_reviewer_prompt(&config.system_prompt)),
        },
        ProviderChatMessage {
            role: "user".to_string(),
            content: ProviderChatMessageContent::text(format!(
                "Review the execution against the plan.\n\nPlan JSON:\n{}\n\nExecution JSON:\n{}",
                serde_json::to_string_pretty(plan)?,
                serde_json::to_string_pretty(execution)?
            )),
        },
    ];

    let response = request_message(
        config,
        messages,
        ProviderChatRequestOptions {
            tools: vec![build_submit_review_tool_definition()],
            tool_choice: Some(ProviderToolChoice::Named("submit_review".to_string())),
            response_format: None,
            stream: false,
        },
        Duration::from_secs(OPS_AGENT_AI_PLAN_TIMEOUT_SECS),
        log_context,
        "review",
    )
    .await?;
    log_provider_response(
        log_context,
        "ai.review.provider_response",
        "ai.review.provider_tool_call",
        &response,
    );

    parse_review_from_response(&response)
}

pub async fn validate_completion(
    config: &AiConfig,
    plan: &OpsAgentWorkflowPlan,
    execution: &OpsAgentExecutionReport,
    review: &OpsAgentReviewReport,
    log_context: Option<OpsAgentLogContext<'_>>,
) -> AppResult<OpsAgentValidationReport> {
    validate_ai_config(config)?;
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.validation.context",
            format!(
                "plan_steps={} execution_steps={} review_concerns={} pending_action={}",
                plan.steps.len(),
                execution.steps.len(),
                review.concerns.len(),
                execution.pending_action.is_some()
            ),
        );
    }

    let messages = vec![
        ProviderChatMessage {
            role: "system".to_string(),
            content: ProviderChatMessageContent::text(build_validator_prompt(&config.system_prompt)),
        },
        ProviderChatMessage {
            role: "user".to_string(),
            content: ProviderChatMessageContent::text(format!(
                "Validate whether the user's task is complete.\n\nPlan JSON:\n{}\n\nExecution JSON:\n{}\n\nReview JSON:\n{}",
                serde_json::to_string_pretty(plan)?,
                serde_json::to_string_pretty(execution)?,
                serde_json::to_string_pretty(review)?
            )),
        },
    ];

    let response = request_message(
        config,
        messages,
        ProviderChatRequestOptions {
            tools: vec![build_submit_validation_tool_definition()],
            tool_choice: Some(ProviderToolChoice::Named("submit_validation".to_string())),
            response_format: None,
            stream: false,
        },
        Duration::from_secs(OPS_AGENT_AI_PLAN_TIMEOUT_SECS),
        log_context,
        "validation",
    )
    .await?;
    log_provider_response(
        log_context,
        "ai.validation.provider_response",
        "ai.validation.provider_tool_call",
        &response,
    );

    parse_validation_from_response(&response)
}

#[allow(dead_code)]
pub async fn stream_tool_summary<F>(
    state: &AppState,
    config: &AiConfig,
    history: &[OpsAgentMessage],
    session_context: &OpsAgentSessionContext,
    tool_kind: &OpsAgentToolKind,
    command: &str,
    output: &str,
    exit_code: Option<i32>,
    log_context: Option<OpsAgentLogContext<'_>>,
    on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    validate_ai_config(config)?;

    let mut messages = Vec::new();
    messages.push(ProviderChatMessage {
        role: "system".to_string(),
        content: ProviderChatMessageContent::text(build_tool_summary_prompt(
            &config.system_prompt,
            session_context,
        )),
    });
    for message in history {
        messages.push(convert_history_message(state, message)?);
    }
    messages.push(ProviderChatMessage {
        role: "user".to_string(),
        content: ProviderChatMessageContent::text(format_tool_result_user_message(
            tool_kind, command, output, exit_code,
        )),
    });

    stream_message(
        config,
        messages,
        ProviderChatRequestOptions::default(),
        Duration::from_secs(OPS_AGENT_AI_STREAM_TIMEOUT_SECS),
        log_context,
        "tool_summary",
        on_delta,
    )
    .await
}

fn build_workflow_planner_prompt(
    base_prompt: &str,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[OpsAgentToolPromptHint],
) -> String {
    format!(
        "{base}\n\nYou are the Planner sub-agent in a serial multi-agent operations workflow.\n\
Your job is to create a short executable plan for the Executor. Do not execute tools.\n\
Registered executor tools:\n{tool_block}\n\n\
Session context:\n{session_block}\n\n\
Rules:\n\
1) Submit the plan via the submit_plan tool.\n\
2) Keep plans short: prefer 1-4 steps, 6 maximum.\n\
3) Use toolKind only when a registered tool is needed. Use null/no toolKind for reasoning-only steps.\n\
4) Shell commands must be concrete, minimal, and read-only unless the user explicitly asked for a change.\n\
5) Include success criteria the Validator can check later.",
        base = base_prompt.trim(),
        tool_block = format_tool_catalog_for_prompt(tool_hints),
        session_block = session_context.to_prompt_block(),
    )
}

fn build_reviewer_prompt(base_prompt: &str) -> String {
    format!(
        "{base}\n\nYou are the Reviewer sub-agent in a serial multi-agent operations workflow.\n\
Review whether the Executor followed the plan, whether evidence supports the result, and whether there are obvious safety or completeness gaps.\n\
Submit your review via the submit_review tool. Be concise and practical.",
        base = base_prompt.trim(),
    )
}

fn build_validator_prompt(base_prompt: &str) -> String {
    format!(
        "{base}\n\nYou are the Validator sub-agent in a serial multi-agent operations workflow.\n\
Determine whether the user's task is complete based only on the plan, execution report, and reviewer report.\n\
Submit validation via the submit_validation tool. Mark completed=false when approval is pending, execution failed, or evidence is insufficient.",
        base = base_prompt.trim(),
    )
}

fn build_submit_plan_tool_definition(
    tool_hints: &[OpsAgentToolPromptHint],
) -> ProviderToolDefinition {
    let tool_enum = tool_hints
        .iter()
        .map(|item| item.kind.to_string())
        .map(|item| json!(item))
        .chain(std::iter::once(json!(null)))
        .collect::<Vec<_>>();
    ProviderToolDefinition {
        name: "submit_plan".to_string(),
        description: "Submit a serial execution plan for the Executor sub-agent.".to_string(),
        parameters: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "One short sentence describing the plan."
                },
                "steps": {
                    "type": "array",
                    "maxItems": 6,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "title": { "type": "string" },
                            "toolKind": {
                                "type": ["string", "null"],
                                "enum": tool_enum
                            },
                            "command": { "type": ["string", "null"] },
                            "reason": { "type": "string" },
                            "successCriteria": { "type": "string" }
                        },
                        "required": ["title", "toolKind", "command", "reason", "successCriteria"]
                    }
                },
                "successCriteria": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            },
            "required": ["summary", "steps", "successCriteria"]
        }),
    }
}

fn build_submit_review_tool_definition() -> ProviderToolDefinition {
    ProviderToolDefinition {
        name: "submit_review".to_string(),
        description: "Submit a review of executor results.".to_string(),
        parameters: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "summary": { "type": "string" },
                "concerns": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "needsFollowUp": { "type": "boolean" }
            },
            "required": ["summary", "concerns", "needsFollowUp"]
        }),
    }
}

fn build_submit_validation_tool_definition() -> ProviderToolDefinition {
    ProviderToolDefinition {
        name: "submit_validation".to_string(),
        description: "Submit a completion validation report.".to_string(),
        parameters: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "completed": { "type": "boolean" },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "summary": { "type": "string" },
                "evidence": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "missingItems": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "suggestedFollowUp": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            },
            "required": ["completed", "confidence", "summary", "evidence", "missingItems", "suggestedFollowUp"]
        }),
    }
}

fn parse_workflow_plan_from_response(
    response: &ProviderChatMessageResponse,
    tool_hints: &[OpsAgentToolPromptHint],
) -> AppResult<OpsAgentWorkflowPlan> {
    let raw = response
        .tool_calls
        .iter()
        .find(|tool_call| tool_call.name == "submit_plan")
        .map(|tool_call| tool_call.arguments.as_str())
        .or_else(|| extract_json_object(response.content.as_str()));

    let Some(raw) = raw else {
        return Err(AppError::Runtime(
            "planner did not return a usable workflow plan".to_string(),
        ));
    };

    let mut plan: OpsAgentWorkflowPlan = serde_json::from_str(raw)?;
    normalize_workflow_plan(&mut plan, tool_hints);
    Ok(plan)
}

fn parse_review_from_response(
    response: &ProviderChatMessageResponse,
) -> AppResult<OpsAgentReviewReport> {
    let raw = response
        .tool_calls
        .iter()
        .find(|tool_call| tool_call.name == "submit_review")
        .map(|tool_call| tool_call.arguments.as_str())
        .or_else(|| extract_json_object(response.content.as_str()));

    let Some(raw) = raw else {
        let summary = response.content.trim();
        if summary.is_empty() {
            return Err(AppError::Runtime(
                "reviewer did not return a usable review".to_string(),
            ));
        }
        return Ok(OpsAgentReviewReport {
            summary: summary.to_string(),
            concerns: Vec::new(),
            needs_follow_up: false,
        });
    };

    Ok(serde_json::from_str(raw)?)
}

fn parse_validation_from_response(
    response: &ProviderChatMessageResponse,
) -> AppResult<OpsAgentValidationReport> {
    let raw = response
        .tool_calls
        .iter()
        .find(|tool_call| tool_call.name == "submit_validation")
        .map(|tool_call| tool_call.arguments.as_str())
        .or_else(|| extract_json_object(response.content.as_str()));

    let Some(raw) = raw else {
        let summary = response.content.trim();
        if summary.is_empty() {
            return Err(AppError::Runtime(
                "validator did not return a usable validation report".to_string(),
            ));
        }
        return Ok(OpsAgentValidationReport {
            completed: false,
            confidence: 0.0,
            summary: summary.to_string(),
            evidence: Vec::new(),
            missing_items: vec!["Validator returned an unstructured response.".to_string()],
            suggested_follow_up: Vec::new(),
        });
    };

    let mut validation: OpsAgentValidationReport = serde_json::from_str(raw)?;
    validation.confidence = validation.confidence.clamp(0.0, 1.0);
    Ok(validation)
}

fn normalize_workflow_plan(plan: &mut OpsAgentWorkflowPlan, tool_hints: &[OpsAgentToolPromptHint]) {
    let registered_tools = tool_hints
        .iter()
        .map(|item| item.kind.to_string())
        .collect::<HashSet<_>>();

    plan.summary = normalize_single_line(plan.summary.as_str());
    if plan.summary.is_empty() {
        plan.summary = "Plan the next operation step.".to_string();
    }

    plan.steps = plan
        .steps
        .iter()
        .take(6)
        .enumerate()
        .map(|(index, step)| {
            let mut next = step.clone();
            next.id = if next.id.trim().is_empty() {
                format!("step-{}", index + 1)
            } else {
                normalize_identifier(next.id.as_str())
            };
            next.title = normalize_single_line(next.title.as_str());
            if next.title.is_empty() {
                next.title = format!("Step {}", index + 1);
            }
            next.reason = normalize_single_line(next.reason.as_str());
            next.success_criteria = normalize_single_line(next.success_criteria.as_str());
            next.command = next
                .command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string());
            next.tool_kind = next.tool_kind.clone().and_then(|kind| {
                let normalized = normalize_tool_kind_alias(kind, &registered_tools);
                if normalized.is_none() || !registered_tools.contains(normalized.as_str()) {
                    None
                } else {
                    Some(normalized)
                }
            });
            if next.tool_kind.is_none() {
                next.command = None;
            }
            next
        })
        .collect();

    plan.success_criteria = plan
        .success_criteria
        .iter()
        .map(|item| normalize_single_line(item))
        .filter(|item| !item.is_empty())
        .take(8)
        .collect();
}

fn extract_json_object(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }

    let fenced_start = trimmed.find("```json")?;
    let after_fence = &trimmed[fenced_start + "```json".len()..];
    let fenced_end = after_fence.find("```")?;
    Some(after_fence[..fenced_end].trim())
}

fn normalize_single_line(value: &str) -> String {
    value
        .replace('\r', " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_identifier(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = normalized.trim_matches('-');
    if trimmed.is_empty() {
        "step".to_string()
    } else {
        trimmed.to_string()
    }
}

fn format_tool_catalog_for_prompt(tool_hints: &[OpsAgentToolPromptHint]) -> String {
    if tool_hints.is_empty() {
        return "- none".to_string();
    }

    tool_hints
        .iter()
        .map(|item| {
            let notes = if item.usage_notes.is_empty() {
                String::new()
            } else {
                format!(" Notes: {}", item.usage_notes.join(" "))
            };
            format!("- {}: {}{}", item.kind, item.description.trim(), notes)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn validate_ai_config(config: &AiConfig) -> AppResult<()> {
    if config.base_url.trim().is_empty() {
        return Err(AppError::Validation("baseUrl cannot be empty".to_string()));
    }
    if config.api_key.trim().is_empty() {
        return Err(AppError::Validation("apiKey cannot be empty".to_string()));
    }
    if config.model.trim().is_empty() {
        return Err(AppError::Validation("model cannot be empty".to_string()));
    }
    Ok(())
}

fn convert_history_message(
    state: &AppState,
    item: &OpsAgentMessage,
) -> AppResult<ProviderChatMessage> {
    let role = match item.role {
        OpsAgentRole::System => "system",
        OpsAgentRole::User => "user",
        OpsAgentRole::Assistant => "assistant",
        OpsAgentRole::Tool => "user",
    };
    let content = if item.role == OpsAgentRole::Tool {
        ProviderChatMessageContent::text(format!("[tool-result]\n{}", item.content))
    } else if item.role == OpsAgentRole::User {
        build_user_history_content(state, item)?
    } else {
        ProviderChatMessageContent::text(item.content.clone())
    };

    Ok(ProviderChatMessage {
        role: role.to_string(),
        content,
    })
}

fn format_user_history_message(item: &OpsAgentMessage) -> String {
    let question = item.content.trim().to_string();
    let mut sections = Vec::new();
    if let Some(shell_context) = &item.shell_context {
        sections.push(format!(
            "Attached shell context from session \"{}\":\n{}",
            shell_context.session_name, shell_context.content
        ));
    }
    if !item.attachment_ids.is_empty() {
        sections.push(format!("Attached images: {}.", item.attachment_ids.len()));
    }
    if !question.is_empty() {
        sections.push(format!("User request:\n{}", question));
    }
    sections.join("\n\n")
}

fn build_user_history_content(
    state: &AppState,
    item: &OpsAgentMessage,
) -> AppResult<ProviderChatMessageContent> {
    let text = format_user_history_message(item);
    if item.attachment_ids.is_empty() {
        return Ok(ProviderChatMessageContent::text(text));
    }

    let mut parts = Vec::new();
    if !text.trim().is_empty() {
        parts.push(ProviderMessageContentPart::Text { text });
    }

    for attachment_id in &item.attachment_ids {
        let attachment = state
            .ops_agent_attachments
            .get_attachment_content(attachment_id)?;
        parts.push(ProviderMessageContentPart::ImageUrl {
            image_url: ProviderImageUrlPart {
                url: format!(
                    "data:{};base64,{}",
                    attachment.content_type, attachment.content_base64
                ),
            },
        });
    }

    Ok(ProviderChatMessageContent::Parts(parts))
}

async fn request_text_completion(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    timeout: Duration,
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
) -> AppResult<String> {
    let response = request_message(
        config,
        messages,
        ProviderChatRequestOptions::default(),
        timeout,
        log_context,
        request_kind,
    )
    .await?;
    log_provider_response(
        log_context,
        "ai.text.provider_response",
        "ai.text.provider_tool_call",
        &response,
    );
    let content = response.content.trim().to_string();
    if content.is_empty() {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.text.empty_response",
                format!("request_kind={request_kind}"),
            );
        }
        return Err(AppError::Runtime(
            "ops agent AI response did not contain usable content".to_string(),
        ));
    }
    Ok(content)
}

fn log_request_context(
    log_context: Option<OpsAgentLogContext<'_>>,
    level_prefix: &str,
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    planner_reply: Option<&str>,
    tool_hints: Option<&[OpsAgentToolPromptHint]>,
) {
    let Some(log_context) = log_context else {
        return;
    };

    let context_level = format!("{level_prefix}.context");
    let shell_context = current_message.shell_context.as_ref();
    let planner_reply = planner_reply.unwrap_or_default();
    log_context.append(
        context_level.as_str(),
        format!(
            "api_type={:?} model={} history_messages={} current_message_id={} current_chars={} current_preview={} attachment_count={} shell_context_attached={} shell_context_chars={} planner_reply_chars={} planner_reply_preview={} session_id={} current_dir={} last_output_chars={} temperature={} max_tokens={} max_context_tokens={} tool_hints={}",
            config.api_type,
            config.model,
            history.len(),
            current_message.id,
            current_message.content.chars().count(),
            truncate_for_log(current_message.content.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
            current_message.attachment_ids.len(),
            shell_context.is_some(),
            shell_context_char_count(shell_context),
            planner_reply.chars().count(),
            truncate_for_log(planner_reply, AI_LOG_MESSAGE_PREVIEW_CHARS),
            session_context.session_id.as_deref().unwrap_or("-"),
            session_context.current_dir.as_deref().unwrap_or("-"),
            session_context
                .last_output_preview
                .as_ref()
                .map(|value| value.chars().count())
                .unwrap_or(0),
            config.temperature,
            config.max_tokens,
            config.max_context_tokens,
            tool_hints.map(|items| items.len()).unwrap_or(0),
        ),
    );

    if let Some(shell_context) = shell_context {
        let shell_level = format!("{level_prefix}.shell_context");
        log_context.append(
            shell_level.as_str(),
            format!(
                "session_id={} session_name={} chars={} preview={}",
                shell_context.session_id.as_deref().unwrap_or("-"),
                shell_context.session_name,
                shell_context_char_count(Some(shell_context)),
                truncate_for_log(shell_context.content.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
            ),
        );
    }

    if let Some(last_output_preview) = session_context.last_output_preview.as_ref() {
        let output_level = format!("{level_prefix}.session_output");
        log_context.append(
            output_level.as_str(),
            format!(
                "chars={} preview={}",
                last_output_preview.chars().count(),
                truncate_for_log(last_output_preview, AI_LOG_LAST_OUTPUT_PREVIEW_CHARS),
            ),
        );
    }

    if let Some(tool_hints) = tool_hints {
        for (index, tool_hint) in tool_hints.iter().enumerate() {
            let tool_level = format!("{level_prefix}.tool_hint");
            log_context.append(
                tool_level.as_str(),
                format!(
                    "index={}/{} kind={} requires_approval={} description={} usage_notes={}",
                    index + 1,
                    tool_hints.len(),
                    tool_hint.kind,
                    tool_hint.requires_approval,
                    truncate_for_log(tool_hint.description.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
                    truncate_for_log(
                        tool_hint.usage_notes.join(" ").as_str(),
                        AI_LOG_MESSAGE_PREVIEW_CHARS
                    ),
                ),
            );
        }
    }
}

fn log_provider_response(
    log_context: Option<OpsAgentLogContext<'_>>,
    response_level: &str,
    tool_call_level: &str,
    response: &ProviderChatMessageResponse,
) {
    let Some(log_context) = log_context else {
        return;
    };

    log_context.append(
        response_level,
        format!(
            "content_chars={} reasoning_chars={} tool_calls={} content_preview={} reasoning_preview={}",
            response.content.chars().count(),
            response.reasoning_content.chars().count(),
            response.tool_calls.len(),
            truncate_for_log(response.content.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
            truncate_for_log(
                response.reasoning_content.as_str(),
                AI_LOG_MESSAGE_PREVIEW_CHARS
            ),
        ),
    );

    for (index, tool_call) in response.tool_calls.iter().enumerate() {
        log_context.append(
            tool_call_level,
            format!(
                "index={}/{} id={} name={} arguments_chars={} arguments_preview={}",
                index + 1,
                response.tool_calls.len(),
                tool_call.id.as_deref().unwrap_or("-"),
                tool_call.name,
                tool_call.arguments.chars().count(),
                truncate_for_log(tool_call.arguments.as_str(), AI_LOG_ARGUMENT_PREVIEW_CHARS),
            ),
        );
    }
}

fn shell_context_char_count(
    shell_context: Option<&crate::ops_agent::domain::types::OpsAgentShellContext>,
) -> usize {
    shell_context
        .map(|value| {
            if value.char_count > 0 {
                value.char_count
            } else {
                value.content.chars().count()
            }
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_plan_tool_definition_includes_registered_tool_kinds() {
        let definition = build_submit_plan_tool_definition(&[
            OpsAgentToolPromptHint {
                kind: OpsAgentToolKind::shell(),
                description: "Run shell".to_string(),
                usage_notes: vec!["Read-only first.".to_string()],
                requires_approval: false,
            },
            OpsAgentToolPromptHint {
                kind: OpsAgentToolKind::ui_context(),
                description: "Read attached UI context".to_string(),
                usage_notes: Vec::new(),
                requires_approval: false,
            },
        ]);

        assert_eq!(definition.name, "submit_plan");
        let tool_kind_enum = &definition.parameters["properties"]["steps"]["items"]["properties"]
            ["toolKind"]["enum"];
        assert_eq!(tool_kind_enum, &json!(["shell", "ui_context", null]));
    }
}
