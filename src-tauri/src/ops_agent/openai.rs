use std::time::Duration;

use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;

use super::context::{
    build_answer_system_prompt, build_planner_system_prompt, build_tool_summary_prompt,
    format_tool_result_user_message, OpsAgentSessionContext, OpsAgentToolPromptHint,
};
use super::logging::{truncate_for_log, OpsAgentLogContext};
use super::providers::{
    openai_compat, parse_planned_reply_from_native_tool_calls, text_fallback, ProviderChatMessage,
    ProviderChatMessageResponse, ProviderChatRequestOptions, ProviderToolChoice,
    ProviderToolDefinition,
};
use super::types::{OpsAgentMessage, OpsAgentRole, OpsAgentToolKind, PlannedAgentReply};

const OPS_AGENT_AI_PLAN_TIMEOUT_SECS: u64 = 45;
const OPS_AGENT_AI_STREAM_TIMEOUT_SECS: u64 = 240;
const AI_LOG_MESSAGE_PREVIEW_CHARS: usize = 280;
const AI_LOG_ARGUMENT_PREVIEW_CHARS: usize = 220;
const AI_LOG_LAST_OUTPUT_PREVIEW_CHARS: usize = 180;

pub async fn plan_reply(
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[OpsAgentToolPromptHint],
    log_context: Option<OpsAgentLogContext<'_>>,
) -> AppResult<PlannedAgentReply> {
    validate_ai_config(config)?;
    log_request_context(
        log_context,
        "ai.plan",
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
        content: build_planner_system_prompt(&config.system_prompt, session_context, tool_hints),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(convert_history_message(current_message));

    let registered_tools = tool_hints
        .iter()
        .map(|item| item.kind.to_string())
        .collect::<std::collections::HashSet<_>>();
    let response = openai_compat::request_message(
        config,
        messages,
        ProviderChatRequestOptions {
            tools: build_planner_tool_definitions(tool_hints),
            tool_choice: (!tool_hints.is_empty()).then_some(ProviderToolChoice::Auto),
            response_format: None,
            stream: false,
        },
        Duration::from_secs(OPS_AGENT_AI_PLAN_TIMEOUT_SECS),
        log_context,
        "plan",
    )
    .await?;
    log_provider_response(
        log_context,
        "ai.plan.provider_response",
        "ai.plan.provider_tool_call",
        &response,
    );

    match parse_planned_reply_from_native_tool_calls(&response, &registered_tools) {
        Ok(Some(plan)) => {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.plan.native_tool_call",
                    format!(
                        "tool={} command={} reason={} reply_preview={}",
                        plan.tool.kind,
                        plan.tool.command.as_deref().unwrap_or("-"),
                        plan.tool.reason.as_deref().unwrap_or("-"),
                        truncate_for_log(plan.reply.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS)
                    ),
                );
            }
            return Ok(plan);
        }
        Ok(None) => {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.plan.native_tool_call_missing",
                    "provider response did not contain native tool calls",
                );
            }
        }
        Err(error) => {
            if let Some(log_context) = log_context {
                log_context.append("ai.plan.native_tool_call_failed", error.to_string());
            }
            return Err(error);
        }
    }

    match text_fallback::parse_planned_reply(&response.content, tool_hints) {
        Ok(plan) => {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.plan.text_fallback",
                    format!(
                        "tool={} command={} reason={} reply_preview={}",
                        plan.tool.kind,
                        plan.tool.command.as_deref().unwrap_or("-"),
                        plan.tool.reason.as_deref().unwrap_or("-"),
                        truncate_for_log(plan.reply.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS)
                    ),
                );
            }
            Ok(plan)
        }
        Err(error) => {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.plan.text_fallback_failed",
                    format!(
                        "error={} response_preview={}",
                        error,
                        truncate_for_log(response.content.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS)
                    ),
                );
            }
            Err(error)
        }
    }
}

pub async fn stream_final_answer<F>(
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
        content: build_answer_system_prompt(&config.system_prompt, session_context, planner_reply),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(convert_history_message(current_message));

    openai_compat::stream_message(
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
            content: "You compress prior ops troubleshooting conversations so the session can continue inside a limited context window.\nSummarize only durable information that should survive compaction:\n- user goals and constraints\n- important environment facts, hosts, file paths, and config values\n- diagnoses, findings, and failed or successful actions\n- pending approvals, open questions, and next steps\nKeep it concise and structured in markdown bullets. Do not repeat low-signal chatter or verbatim logs.".to_string(),
        },
        ProviderChatMessage {
            role: "user".to_string(),
            content: format!(
                "Compress the following earlier conversation history into a compact summary for future turns:\n\n{transcript}"
            ),
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

#[allow(dead_code)]
pub async fn stream_tool_summary<F>(
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
        content: build_tool_summary_prompt(&config.system_prompt, session_context),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(ProviderChatMessage {
        role: "user".to_string(),
        content: format_tool_result_user_message(tool_kind, command, output, exit_code),
    });

    openai_compat::stream_message(
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

fn convert_history_message(item: &OpsAgentMessage) -> ProviderChatMessage {
    let role = match item.role {
        OpsAgentRole::System => "system",
        OpsAgentRole::User => "user",
        OpsAgentRole::Assistant => "assistant",
        OpsAgentRole::Tool => "user",
    };
    let content = if item.role == OpsAgentRole::Tool {
        format!("[tool-result]\n{}", item.content)
    } else if item.role == OpsAgentRole::User {
        format_user_history_message(item)
    } else {
        item.content.clone()
    };

    ProviderChatMessage {
        role: role.to_string(),
        content,
    }
}

fn format_user_history_message(item: &OpsAgentMessage) -> String {
    let question = item.content.trim().to_string();
    let Some(shell_context) = &item.shell_context else {
        return question;
    };

    format!(
        "Attached shell context from session \"{}\":\n{}\n\nUser request:\n{}",
        shell_context.session_name, shell_context.content, question
    )
}

fn build_planner_tool_definitions(
    tool_hints: &[OpsAgentToolPromptHint],
) -> Vec<ProviderToolDefinition> {
    tool_hints
        .iter()
        .map(|tool| {
            let requires_command = tool.kind != OpsAgentToolKind::ui_context();
            let mut required = vec!["reason"];
            if requires_command {
                required.insert(0, "command");
            }
            let approval = if tool.requires_approval {
                "May require approval before execution."
            } else {
                "Can run immediately when safe."
            };
            let usage_notes = if tool.usage_notes.is_empty() {
                String::new()
            } else {
                format!(" {}", tool.usage_notes.join(" "))
            };

            ProviderToolDefinition {
                name: tool.kind.to_string(),
                description: format!(
                    "{} {}{}",
                    tool.description.trim(),
                    approval,
                    usage_notes
                )
                .trim()
                .to_string(),
                parameters: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": if requires_command {
                                "Concrete command or input for this tool."
                            } else {
                                "Optional command or selector. This tool may ignore it."
                            }
                        },
                        "reason": {
                            "type": "string",
                            "description": "Short reason explaining why this tool is needed now."
                        }
                    },
                    "required": required
                }),
            }
        })
        .collect()
}

async fn request_text_completion(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    timeout: Duration,
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
) -> AppResult<String> {
    let response = openai_compat::request_message(
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
            "model={} history_messages={} current_message_id={} current_chars={} current_preview={} shell_context_attached={} shell_context_chars={} planner_reply_chars={} planner_reply_preview={} session_id={} current_dir={} last_output_chars={} temperature={} max_tokens={} max_context_tokens={} tool_hints={}",
            config.model,
            history.len(),
            current_message.id,
            current_message.content.chars().count(),
            truncate_for_log(current_message.content.as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
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
                    truncate_for_log(tool_hint.usage_notes.join(" ").as_str(), AI_LOG_MESSAGE_PREVIEW_CHARS),
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
    shell_context: Option<&super::types::OpsAgentShellContext>,
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
    fn planner_tool_definitions_follow_openai_function_shape() {
        let definitions = build_planner_tool_definitions(&[
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

        assert_eq!(definitions.len(), 2);
        assert_eq!(definitions[0].name, "shell");
        assert_eq!(
            definitions[0].parameters["required"],
            json!(["command", "reason"])
        );
        assert_eq!(definitions[1].name, "ui_context");
        assert_eq!(definitions[1].parameters["required"], json!(["reason"]));
    }
}
