use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;

use super::context::{
    build_answer_system_prompt, build_planner_system_prompt, build_tool_summary_prompt,
    format_tool_result_user_message, OpsAgentSessionContext, OpsAgentToolPromptHint,
};
use super::stream::SseEventDecoder;
use super::types::{
    OpsAgentMessage, OpsAgentRole, OpsAgentToolKind, PlannedAgentReply, PlannedToolAction,
};

const OPS_AGENT_AI_PLAN_TIMEOUT_SECS: u64 = 45;
const OPS_AGENT_AI_STREAM_TIMEOUT_SECS: u64 = 240;

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
    current_message: &OpsAgentMessage,
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
    messages.push(convert_history_message(current_message));

    let content = request_chat_completion(config, messages).await?;
    parse_plan_payload(&content, tool_hints)
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
    messages.push(WireChatMessage {
        role: "system".to_string(),
        content: build_answer_system_prompt(&config.system_prompt, session_context, planner_reply),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(convert_history_message(current_message));

    stream_chat_completion(config, messages, on_delta).await
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
        WireChatMessage {
            role: "system".to_string(),
            content: "You compress prior ops troubleshooting conversations so the session can continue inside a limited context window.\nSummarize only durable information that should survive compaction:\n- user goals and constraints\n- important environment facts, hosts, file paths, and config values\n- diagnoses, findings, and failed or successful actions\n- pending approvals, open questions, and next steps\nKeep it concise and structured in markdown bullets. Do not repeat low-signal chatter or verbatim logs.".to_string(),
        },
        WireChatMessage {
            role: "user".to_string(),
            content: format!(
                "Compress the following earlier conversation history into a compact summary for future turns:\n\n{transcript}"
            ),
        },
    ];

    request_chat_completion(&summary_config, messages).await
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
    } else if item.role == OpsAgentRole::User {
        format_user_history_message(item)
    } else {
        item.content.clone()
    };
    WireChatMessage {
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

async fn request_chat_completion(
    config: &AiConfig,
    messages: Vec<WireChatMessage>,
) -> AppResult<String> {
    let response = build_client_request(
        config,
        messages,
        None,
        Duration::from_secs(OPS_AGENT_AI_PLAN_TIMEOUT_SECS),
    )
    .send()
    .await?;
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
    let response = build_client_request(
        config,
        messages,
        Some(true),
        Duration::from_secs(OPS_AGENT_AI_STREAM_TIMEOUT_SECS),
    )
    .send()
    .await?;
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
    timeout: Duration,
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
        .timeout(timeout)
        .bearer_auth(&config.api_key)
        .json(&payload)
}

fn parse_plan_payload(
    raw: &str,
    tool_hints: &[OpsAgentToolPromptHint],
) -> AppResult<PlannedAgentReply> {
    let registered = tool_hints
        .iter()
        .map(|item| item.kind.to_string())
        .collect::<HashSet<_>>();
    for candidate in iter_plan_payload_candidates(raw) {
        if let Ok(payload) = serde_json::from_str::<PlanPayload>(&candidate) {
            return Ok(normalize_planned_reply(payload, &registered));
        }
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

    let requested_kind = normalize_tool_kind_alias(
        OpsAgentToolKind::new(tool.kind.unwrap_or_default()),
        registered_tools,
    );
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
    let normalized_command = if normalized_kind.is_none() {
        None
    } else {
        command
    };

    PlannedAgentReply {
        reply,
        tool: PlannedToolAction {
            kind: normalized_kind,
            command: normalized_command,
            reason: tool.reason.map(|item| item.trim().to_string()),
        },
    }
}

fn normalize_tool_kind_alias(
    requested_kind: OpsAgentToolKind,
    registered_tools: &HashSet<String>,
) -> OpsAgentToolKind {
    if requested_kind == OpsAgentToolKind::read_shell()
        || requested_kind == OpsAgentToolKind::write_shell()
    {
        if registered_tools.contains(OpsAgentToolKind::shell().as_str()) {
            return OpsAgentToolKind::shell();
        }
    }

    if requested_kind == OpsAgentToolKind::new("read_ui_context")
        && registered_tools.contains(OpsAgentToolKind::ui_context().as_str())
    {
        return OpsAgentToolKind::ui_context();
    }

    requested_kind
}

fn parse_stream_delta(raw: &str) -> AppResult<Option<String>> {
    let payload: ChatCompletionsStreamResponse = serde_json::from_str(raw)?;
    Ok(payload
        .choices
        .into_iter()
        .find_map(|item| item.delta.content)
        .map(|item| item.trim_end_matches('\0').to_string()))
}

#[cfg(test)]
fn extract_json_payload(raw: &str) -> Option<String> {
    extract_json_objects(raw).into_iter().next()
}

fn iter_plan_payload_candidates(raw: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        candidates.push(trimmed.to_string());
    }

    for object in extract_json_objects(trimmed) {
        if !candidates.iter().any(|item| item == &object) {
            candidates.push(object);
        }
    }

    candidates
}

fn extract_json_objects(raw: &str) -> Vec<String> {
    let mut rows = Vec::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let Some(offset) = raw[cursor..].find('{') else {
            break;
        };
        let start = cursor + offset;
        if let Some(end) = find_balanced_json_object_end(raw, start) {
            if end >= start {
                rows.push(raw[start..=end].to_string());
                cursor = end + 1;
                continue;
            }
        }
        cursor = start + 1;
    }
    rows
}

fn find_balanced_json_object_end(raw: &str, start: usize) -> Option<usize> {
    if raw.get(start..=start)? != "{" {
        return None;
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (relative_index, ch) in raw[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                if depth == 0 {
                    return Some(start + relative_index);
                }
            }
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops_agent::types::OpsAgentShellContext;

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
                kind: OpsAgentToolKind::shell(),
                description: "read".to_string(),
                usage_notes: Vec::new(),
                requires_approval: false,
            }],
        )
        .expect("parse plan");

        assert_eq!(payload.tool.kind, OpsAgentToolKind::shell());
        assert_eq!(payload.tool.command.as_deref(), Some("df -h"));
    }

    #[test]
    fn parse_plan_payload_maps_legacy_write_shell_to_shell() {
        let payload = parse_plan_payload(
            r#"{"reply":"restart","tool":{"kind":"write_shell","command":"systemctl restart nginx","reason":"recover"}}"#,
            &[OpsAgentToolPromptHint {
                kind: OpsAgentToolKind::shell(),
                description: "shell".to_string(),
                usage_notes: Vec::new(),
                requires_approval: false,
            }],
        )
        .expect("parse plan");

        assert_eq!(payload.tool.kind, OpsAgentToolKind::shell());
        assert_eq!(
            payload.tool.command.as_deref(),
            Some("systemctl restart nginx")
        );
    }

    #[test]
    fn parse_stream_delta_reads_content_chunks() {
        let delta = parse_stream_delta(
            r#"{"choices":[{"delta":{"content":"hello "}},{"delta":{"content":"ignored"}}]}"#,
        )
        .expect("parse delta");

        assert_eq!(delta.as_deref(), Some("hello "));
    }

    #[test]
    fn convert_history_message_includes_shell_context_for_user_messages() {
        let wire = convert_history_message(&OpsAgentMessage {
            id: "msg-1".to_string(),
            role: OpsAgentRole::User,
            content: "Why did nginx fail?".to_string(),
            created_at: "2026-03-20T00:00:00Z".to_string(),
            tool_kind: None,
            shell_context: Some(OpsAgentShellContext {
                session_id: Some("session-1".to_string()),
                session_name: "Prod".to_string(),
                content: "systemctl status nginx".to_string(),
                preview: "systemctl status nginx".to_string(),
                char_count: 22,
            }),
        });

        assert_eq!(wire.role, "user");
        assert!(wire
            .content
            .contains("Attached shell context from session \"Prod\""));
        assert!(wire.content.contains("systemctl status nginx"));
        assert!(wire.content.contains("User request:\nWhy did nginx fail?"));
    }

    #[test]
    fn parse_plan_payload_uses_first_valid_json_object_when_multiple_are_returned() {
        let raw = r#"{"reply":"查看本地Hadoop安装情况","tool":{"kind":"shell","command":"which hadoop && hadoop version","reason":"检查Hadoop是否安装及版本"}}
{"reply":"查看Hadoop配置文件","tool":{"kind":"shell","command":"ls -la $HADOOP_HOME/etc/hadoop","reason":"检查配置文件"}}"#;
        let payload = parse_plan_payload(
            raw,
            &[OpsAgentToolPromptHint {
                kind: OpsAgentToolKind::shell(),
                description: "shell".to_string(),
                usage_notes: Vec::new(),
                requires_approval: false,
            }],
        )
        .expect("parse plan");

        assert_eq!(payload.tool.kind, OpsAgentToolKind::shell());
        assert_eq!(
            payload.tool.command.as_deref(),
            Some("which hadoop && hadoop version")
        );
    }

    #[test]
    fn extract_json_payload_reads_first_object_from_multiple_json_blocks() {
        let raw = r#"prefix
{"reply":"a","tool":{"kind":"none","command":"","reason":""}}
{"reply":"b","tool":{"kind":"none","command":"","reason":""}}"#;
        let payload = extract_json_payload(raw).expect("first json object");
        assert_eq!(
            payload,
            r#"{"reply":"a","tool":{"kind":"none","command":"","reason":""}}"#
        );
    }
}
