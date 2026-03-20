use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;

use super::context::{
    build_answer_system_prompt, build_planner_system_prompt, build_tool_summary_prompt,
    format_tool_result_user_message, OpsAgentSessionContext, OpsAgentToolPromptHint,
};
use super::stream::SseEventDecoder;
use super::types::{OpsAgentMessage, OpsAgentRole, OpsAgentToolKind, PlannedAgentReply, PlannedToolAction};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<WireChatMessage>,
    temperature: f64,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
struct WireChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsStreamResponse {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Debug, Deserialize, Default)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlanPayload {
    reply: Option<String>,
    tool: Option<PlanToolPayload>,
}

#[derive(Debug, Deserialize)]
struct PlanToolPayload {
    kind: Option<String>,
    command: Option<String>,
    reason: Option<String>,
}

pub async fn plan_reply(
    config: &AiConfig,
    history: &[OpsAgentMessage],
    user_question: &str,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[OpsAgentToolPromptHint],
) -> AppResult<PlannedAgentReply> {
    validate_ai_config(config)?;

    let mut messages = Vec::new();
    messages.push(WireChatMessage {
        role: "system".to_string(),
        content: build_planner_system_prompt(&config.system_prompt, session_context, tool_hints),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(WireChatMessage {
        role: "user".to_string(),
        content: user_question.trim().to_string(),
    });

    let content = request_chat_completion(config, messages).await?;
    parse_plan_payload(&content, tool_hints)
}

pub async fn stream_final_answer<F>(
    config: &AiConfig,
    history: &[OpsAgentMessage],
    user_question: &str,
    session_context: &OpsAgentSessionContext,
    planner_reply: Option<&str>,
    on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    validate_ai_config(config)?;

    let mut messages = Vec::new();
    messages.push(WireChatMessage {
        role: "system".to_string(),
        content: build_answer_system_prompt(&config.system_prompt, session_context, planner_reply),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(WireChatMessage {
        role: "user".to_string(),
        content: user_question.trim().to_string(),
    });

    stream_chat_completion(config, messages, on_delta).await
}

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
    messages.push(WireChatMessage {
        role: "system".to_string(),
        content: build_tool_summary_prompt(&config.system_prompt, session_context),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(WireChatMessage {
        role: "user".to_string(),
        content: format_tool_result_user_message(tool_kind, command, output, exit_code),
    });

    stream_chat_completion(config, messages, on_delta).await
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

fn convert_history_message(item: &OpsAgentMessage) -> WireChatMessage {
    let role = match item.role {
        OpsAgentRole::System => "system",
        OpsAgentRole::User => "user",
        OpsAgentRole::Assistant => "assistant",
        OpsAgentRole::Tool => "user",
    };
    let content = if item.role == OpsAgentRole::Tool {
        format!("[tool-result]\n{}", item.content)
    } else {
        item.content.clone()
    };
    WireChatMessage {
        role: role.to_string(),
        content,
    }
}

async fn request_chat_completion(
    config: &AiConfig,
    messages: Vec<WireChatMessage>,
) -> AppResult<String> {
    let response = build_client_request(config, messages, None).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Runtime(format!(
            "ops agent AI request failed: status={status}, body={body}"
        )));
    }

    let body: ChatCompletionsResponse = response.json().await?;
    let content = body
        .choices
        .first()
        .map(|item| item.message.content.trim().to_string())
        .unwrap_or_default();

    if content.is_empty() {
        return Err(AppError::Runtime(
            "ops agent AI response did not contain usable content".to_string(),
        ));
    }
    Ok(content)
}

async fn stream_chat_completion<F>(
    config: &AiConfig,
    messages: Vec<WireChatMessage>,
    mut on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    let response = build_client_request(config, messages, Some(true)).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Runtime(format!(
            "ops agent AI stream request failed: status={status}, body={body}"
        )));
    }

    let mut full_answer = String::new();
    let mut decoder = SseEventDecoder::default();
    let mut response = response;

    while let Some(chunk) = response.chunk().await? {
        for event in decoder.push(chunk.as_ref()) {
            if event.data == "[DONE]" {
                continue;
            }

            if let Some(delta) = parse_stream_delta(&event.data)? {
                if delta.is_empty() {
                    continue;
                }
                on_delta(&delta)?;
                full_answer.push_str(&delta);
            }
        }
    }

    for event in decoder.finish() {
        if event.data == "[DONE]" {
            continue;
        }

        if let Some(delta) = parse_stream_delta(&event.data)? {
            if delta.is_empty() {
                continue;
            }
            on_delta(&delta)?;
            full_answer.push_str(&delta);
        }
    }

    if full_answer.trim().is_empty() {
        return Err(AppError::Runtime(
            "ops agent AI stream did not produce usable content".to_string(),
        ));
    }

    Ok(full_answer)
}

fn build_client_request(
    config: &AiConfig,
    messages: Vec<WireChatMessage>,
    stream: Option<bool>,
) -> reqwest::RequestBuilder {
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let payload = ChatCompletionsRequest {
        model: config.model.clone(),
        messages,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        stream,
    };

    reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(&config.api_key)
        .json(&payload)
}

fn parse_plan_payload(raw: &str, tool_hints: &[OpsAgentToolPromptHint]) -> AppResult<PlannedAgentReply> {
    let json_text = extract_json_payload(raw).unwrap_or_else(|| raw.trim().to_string());
    if let Ok(payload) = serde_json::from_str::<PlanPayload>(&json_text) {
        let registered = tool_hints
            .iter()
            .map(|item| item.kind.to_string())
            .collect::<HashSet<_>>();
        return Ok(normalize_planned_reply(payload, &registered));
    }

    Ok(PlannedAgentReply {
        reply: raw.trim().to_string(),
        tool: PlannedToolAction {
            kind: OpsAgentToolKind::none(),
            command: None,
            reason: None,
        },
    })
}

fn normalize_planned_reply(
    payload: PlanPayload,
    registered_tools: &HashSet<String>,
) -> PlannedAgentReply {
    let reply = payload.reply.unwrap_or_default().trim().to_string();
    let tool = payload.tool.unwrap_or(PlanToolPayload {
        kind: Some("none".to_string()),
        command: None,
        reason: None,
    });

    let requested_kind = OpsAgentToolKind::new(tool.kind.unwrap_or_default());
    let kind = if requested_kind.is_none() || registered_tools.contains(requested_kind.as_str()) {
        requested_kind
    } else {
        OpsAgentToolKind::none()
    };

    let command = tool.command.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    let normalized_kind = if command.is_none() {
        OpsAgentToolKind::none()
    } else {
        kind
    };
    let normalized_command = if normalized_kind.is_none() { None } else { command };

    PlannedAgentReply {
        reply,
        tool: PlannedToolAction {
            kind: normalized_kind,
            command: normalized_command,
            reason: tool.reason.map(|item| item.trim().to_string()),
        },
    }
}

fn parse_stream_delta(raw: &str) -> AppResult<Option<String>> {
    let payload: ChatCompletionsStreamResponse = serde_json::from_str(raw)?;
    Ok(payload
        .choices
        .into_iter()
        .find_map(|item| item.delta.content)
        .map(|item| item.trim_end_matches('\0').to_string()))
}

fn extract_json_payload(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed.to_string());
    }

    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end > start {
                return Some(trimmed[start..=end].to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plan_payload_ignores_unregistered_tool() {
        let payload = parse_plan_payload(
            r#"{"reply":"check","tool":{"kind":"reboot_server","command":"reboot","reason":"danger"}}"#,
            &[OpsAgentToolPromptHint {
                kind: OpsAgentToolKind::read_shell(),
                description: "read".to_string(),
                usage_notes: Vec::new(),
                requires_approval: false,
            }],
        )
        .expect("parse plan");

        assert!(payload.tool.kind.is_none());
        assert!(payload.tool.command.is_none());
    }

    #[test]
    fn parse_plan_payload_keeps_registered_tool() {
        let payload = parse_plan_payload(
            r#"{"reply":"check","tool":{"kind":"read_shell","command":"df -h","reason":"inspect"}}"#,
            &[OpsAgentToolPromptHint {
                kind: OpsAgentToolKind::read_shell(),
                description: "read".to_string(),
                usage_notes: Vec::new(),
                requires_approval: false,
            }],
        )
        .expect("parse plan");

        assert_eq!(payload.tool.kind, OpsAgentToolKind::read_shell());
        assert_eq!(payload.tool.command.as_deref(), Some("df -h"));
    }

    #[test]
    fn parse_stream_delta_reads_content_chunks() {
        let delta = parse_stream_delta(
            r#"{"choices":[{"delta":{"content":"hello "}},{"delta":{"content":"ignored"}}]}"#,
        )
        .expect("parse delta");

        assert_eq!(delta.as_deref(), Some("hello "));
    }
}
