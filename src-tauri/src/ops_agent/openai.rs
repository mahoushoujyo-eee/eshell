use std::time::Duration;

use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;

use super::context::{
    build_answer_system_prompt, build_planner_system_prompt, build_tool_summary_prompt,
    format_tool_result_user_message, OpsAgentSessionContext, OpsAgentToolPromptHint,
};
use super::providers::{
    openai_compat, parse_planned_reply_from_native_tool_calls, text_fallback, ProviderChatMessage,
    ProviderChatRequestOptions, ProviderToolChoice, ProviderToolDefinition,
};
use super::types::{OpsAgentMessage, OpsAgentRole, OpsAgentToolKind, PlannedAgentReply};

const OPS_AGENT_AI_PLAN_TIMEOUT_SECS: u64 = 45;
const OPS_AGENT_AI_STREAM_TIMEOUT_SECS: u64 = 240;

pub async fn plan_reply(
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[OpsAgentToolPromptHint],
) -> AppResult<PlannedAgentReply> {
    validate_ai_config(config)?;

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
    )
    .await?;

    if let Some(plan) = parse_planned_reply_from_native_tool_calls(&response, &registered_tools)? {
        return Ok(plan);
    }

    text_fallback::parse_planned_reply(&response.content, tool_hints)
}

pub async fn stream_final_answer<F>(
    config: &AiConfig,
    history: &[OpsAgentMessage],
    current_message: &OpsAgentMessage,
    session_context: &OpsAgentSessionContext,
    planner_reply: Option<&str>,
    on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    validate_ai_config(config)?;

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
        on_delta,
    )
    .await
}

pub async fn compact_history_summary(
    config: &AiConfig,
    transcript: &str,
    target_max_tokens: u32,
) -> AppResult<String> {
    validate_ai_config(config)?;

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
) -> AppResult<String> {
    let response = openai_compat::request_message(
        config,
        messages,
        ProviderChatRequestOptions::default(),
        timeout,
    )
    .await?;
    let content = response.content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::Runtime(
            "ops agent AI response did not contain usable content".to_string(),
        ));
    }
    Ok(content)
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
