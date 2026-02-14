use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;

use super::types::{OpsAgentMessage, OpsAgentRole, OpsAgentToolKind, PlannedAgentReply, PlannedToolAction};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<WireChatMessage>,
    temperature: f64,
    max_tokens: u32,
}

#[derive(Debug, Serialize)]
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
    session_id: Option<&str>,
) -> AppResult<PlannedAgentReply> {
    validate_ai_config(config)?;
    let mut messages = Vec::new();
    messages.push(WireChatMessage {
        role: "system".to_string(),
        content: build_planner_system_prompt(config, session_id),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(WireChatMessage {
        role: "user".to_string(),
        content: user_question.trim().to_string(),
    });

    let content = request_chat_completion(config, messages).await?;
    parse_plan_payload(&content)
}

pub async fn summarize_tool_result(
    config: &AiConfig,
    history: &[OpsAgentMessage],
    tool_kind: OpsAgentToolKind,
    command: &str,
    output: &str,
    exit_code: Option<i32>,
) -> AppResult<String> {
    validate_ai_config(config)?;
    let mut messages = Vec::new();
    messages.push(WireChatMessage {
        role: "system".to_string(),
        content: build_tool_summary_prompt(config),
    });
    messages.extend(history.iter().map(convert_history_message));
    messages.push(WireChatMessage {
        role: "user".to_string(),
        content: format!(
            "Tool execution result\nkind: {:?}\ncommand: {}\nexitCode: {}\noutput:\n{}",
            tool_kind,
            command,
            exit_code
                .map(|item| item.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
            output
        ),
    });

    request_chat_completion(config, messages).await
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

fn build_planner_system_prompt(config: &AiConfig, session_id: Option<&str>) -> String {
    let session_hint = session_id
        .map(|item| format!("Current SSH session id: {item}"))
        .unwrap_or_else(|| "Current SSH session id: unavailable".to_string());
    format!(
        "{base}\n\nYou are an operations agent planner. Decide whether a tool call is needed.\n\
Return STRICT JSON only without markdown:\n\
{{\"reply\":\"...\",\"tool\":{{\"kind\":\"none|read_shell|write_shell\",\"command\":\"...\",\"reason\":\"...\"}}}}\n\
Rules:\n\
1) read_shell: use only for safe read-only diagnostics like ls/cat/grep/df/free/ps/top/uptime.\n\
2) write_shell: use for any command that mutates system state.\n\
3) If no command needed, set kind to \"none\" and command empty.\n\
4) reply must be concise and user-facing.\n\
{session_hint}",
        base = config.system_prompt.trim()
    )
}

fn build_tool_summary_prompt(config: &AiConfig) -> String {
    format!(
        "{base}\n\nGiven shell tool execution result, provide a concise operations answer in markdown.\n\
Include: what happened, key evidence, and safe next step command when useful.",
        base = config.system_prompt.trim()
    )
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
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let payload = ChatCompletionsRequest {
        model: config.model.clone(),
        messages,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(&config.api_key)
        .json(&payload)
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

fn parse_plan_payload(raw: &str) -> AppResult<PlannedAgentReply> {
    let json_text = extract_json_payload(raw).unwrap_or_else(|| raw.trim().to_string());
    if let Ok(payload) = serde_json::from_str::<PlanPayload>(&json_text) {
        return Ok(normalize_planned_reply(payload));
    }

    Ok(PlannedAgentReply {
        reply: raw.trim().to_string(),
        tool: PlannedToolAction {
            kind: OpsAgentToolKind::None,
            command: None,
            reason: None,
        },
    })
}

fn normalize_planned_reply(payload: PlanPayload) -> PlannedAgentReply {
    let reply = payload
        .reply
        .unwrap_or_default()
        .trim()
        .to_string();
    let tool = payload.tool.unwrap_or(PlanToolPayload {
        kind: Some("none".to_string()),
        command: None,
        reason: None,
    });

    let kind = match tool.kind.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "read_shell" => OpsAgentToolKind::ReadShell,
        "write_shell" => OpsAgentToolKind::WriteShell,
        _ => OpsAgentToolKind::None,
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
        OpsAgentToolKind::None
    } else {
        kind
    };

    PlannedAgentReply {
        reply,
        tool: PlannedToolAction {
            kind: normalized_kind,
            command,
            reason: tool.reason.map(|item| item.trim().to_string()),
        },
    }
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
