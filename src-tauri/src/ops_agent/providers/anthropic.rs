use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;
use crate::ops_agent::infrastructure::logging::{truncate_for_log, OpsAgentLogContext};
use crate::ops_agent::transport::stream::{SseEvent, SseEventDecoder};

use super::types::{
    ProviderChatMessage, ProviderChatMessageContent, ProviderChatMessageResponse,
    ProviderChatRequestOptions, ProviderMessageContentPart, ProviderToolCall, ProviderToolChoice,
};

const PROVIDER_LOG_MESSAGE_PREVIEW_CHARS: usize = 320;
const PROVIDER_LOG_TOOL_PREVIEW_CHARS: usize = 220;
const PROVIDER_LOG_BODY_PREVIEW_CHARS: usize = 640;
const PROVIDER_LOG_EVENT_PREVIEW_CHARS: usize = 220;
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Serialize)]
struct MessagesRequest {
    model: String,
    max_tokens: u32,
    temperature: f64,
    messages: Vec<WireMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<WireToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Serialize)]
struct WireMessage {
    role: String,
    content: Value,
}

#[derive(Debug, Serialize)]
struct WireToolDefinition {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    content: Vec<ResponseContentBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponseContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize, Default)]
struct StreamPayload {
    #[serde(rename = "type", default)]
    type_name: String,
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    error: Option<AnthropicError>,
}

#[derive(Debug, Deserialize, Default)]
struct StreamDelta {
    #[serde(rename = "type", default)]
    type_name: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct AnthropicError {
    #[serde(default)]
    message: String,
}

pub async fn request_message(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    options: ProviderChatRequestOptions,
    timeout: Duration,
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
) -> AppResult<ProviderChatMessageResponse> {
    log_request(log_context, request_kind, config, &messages, &options, timeout);

    let response = build_client_request(config, messages, options, timeout)?
        .send()
        .await
        .map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.http_error",
                    format!("kind={request_kind} provider=anthropic_messages error={error}"),
                );
            }
            AppError::from(error)
        })?;
    let status = response.status();
    let content_length = response.content_length();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_failed",
                format!(
                    "kind={request_kind} provider=anthropic_messages status={status} content_length={:?} body_chars={} body_preview={}",
                    content_length,
                    body.chars().count(),
                    truncate_for_log(body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
                ),
            );
        }
        return Err(AppError::Runtime(format!(
            "ops agent AI request failed: status={status}, body={body}"
        )));
    }

    let raw_body = response.text().await.map_err(|error| {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_read_failed",
                format!("kind={request_kind} provider=anthropic_messages status={status} error={error}"),
            );
        }
        AppError::from(error)
    })?;
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.provider.response_body",
            format!(
                "kind={request_kind} provider=anthropic_messages status={status} content_length={:?} body_chars={} body_preview={}",
                content_length,
                raw_body.chars().count(),
                truncate_for_log(raw_body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
            ),
        );
    }

    let body: MessagesResponse = serde_json::from_str(&raw_body).map_err(|error| {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_parse_failed",
                format!(
                    "kind={request_kind} provider=anthropic_messages status={status} error={} body_preview={}",
                    error,
                    truncate_for_log(raw_body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
                ),
            );
        }
        AppError::from(error)
    })?;

    let message = normalize_response(body.content)?;
    log_response_message(log_context, request_kind, &message);
    if message.content.trim().is_empty()
        && message.reasoning_content.trim().is_empty()
        && message.tool_calls.is_empty()
    {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_unusable",
                format!("kind={request_kind} provider=anthropic_messages status={status}"),
            );
        }
        return Err(AppError::Runtime(
            "ops agent AI response did not contain usable content".to_string(),
        ));
    }

    Ok(message)
}

pub async fn stream_message<F>(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    mut options: ProviderChatRequestOptions,
    timeout: Duration,
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
    mut on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    options.stream = true;
    log_request(log_context, request_kind, config, &messages, &options, timeout);

    let response = build_client_request(config, messages, options, timeout)?
        .send()
        .await
        .map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_http_error",
                    format!("kind={request_kind} provider=anthropic_messages error={error}"),
                );
            }
            AppError::from(error)
        })?;
    let status = response.status();
    let content_length = response.content_length();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_failed",
                format!(
                    "kind={request_kind} provider=anthropic_messages status={status} content_length={:?} body_chars={} body_preview={}",
                    content_length,
                    body.chars().count(),
                    truncate_for_log(body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
                ),
            );
        }
        return Err(AppError::Runtime(format!(
            "ops agent AI stream request failed: status={status}, body={body}"
        )));
    }
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.provider.stream_opened",
            format!(
                "kind={request_kind} provider=anthropic_messages status={status} content_length={:?}",
                content_length
            ),
        );
    }

    let mut full_answer = String::new();
    let mut decoder = SseEventDecoder::default();
    let mut response = response;
    let mut stats = StreamStats::default();

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_chunk_failed",
                format!(
                    "kind={request_kind} provider=anthropic_messages status={status} chunks={} bytes={} error={error}",
                    stats.chunks, stats.bytes
                ),
            );
        }
        AppError::from(error)
    })? {
        stats.chunks += 1;
        stats.bytes += chunk.len();
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_chunk",
                format!(
                    "kind={request_kind} provider=anthropic_messages chunk_index={} bytes={}",
                    stats.chunks,
                    chunk.len()
                ),
            );
        }
        process_stream_events(
            log_context,
            request_kind,
            decoder.push(chunk.as_ref()),
            &mut stats,
            &mut full_answer,
            &mut on_delta,
        )?;
    }

    process_stream_events(
        log_context,
        request_kind,
        decoder.finish(),
        &mut stats,
        &mut full_answer,
        &mut on_delta,
    )?;

    if full_answer.trim().is_empty() {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_empty",
                format!(
                    "kind={request_kind} provider=anthropic_messages chunks={} bytes={} events={} delta_events={}",
                    stats.chunks,
                    stats.bytes,
                    stats.events,
                    stats.delta_events
                ),
            );
        }
        return Err(AppError::Runtime(
            "ops agent AI stream did not produce usable content".to_string(),
        ));
    }

    if let Some(log_context) = log_context {
        log_context.append(
            "ai.provider.stream_completed",
            format!(
                "kind={request_kind} provider=anthropic_messages chunks={} bytes={} events={} delta_events={} delta_chars={} answer_chars={}",
                stats.chunks,
                stats.bytes,
                stats.events,
                stats.delta_events,
                stats.delta_chars,
                full_answer.chars().count()
            ),
        );
    }

    Ok(full_answer)
}

fn build_client_request(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    options: ProviderChatRequestOptions,
    timeout: Duration,
) -> AppResult<reqwest::RequestBuilder> {
    let endpoint = format!("{}/v1/messages", config.base_url.trim_end_matches('/'));
    let (system, messages) = split_messages(messages)?;
    let payload = MessagesRequest {
        model: config.model.clone(),
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        messages,
        system,
        tools: if options.tools.is_empty() {
            None
        } else {
            Some(
                options
                    .tools
                    .into_iter()
                    .map(|tool| WireToolDefinition {
                        name: tool.name,
                        description: tool.description,
                        input_schema: tool.parameters,
                    })
                    .collect(),
            )
        },
        tool_choice: options.tool_choice.map(serialize_tool_choice),
        stream: options.stream.then_some(true),
    };

    Ok(reqwest::Client::new()
        .post(endpoint)
        .timeout(timeout)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&payload))
}

fn split_messages(messages: Vec<ProviderChatMessage>) -> AppResult<(Option<String>, Vec<WireMessage>)> {
    let mut system_parts = Vec::new();
    let mut wire_messages = Vec::new();

    for message in messages {
        if message.role == "system" {
            let content = message.content.text_preview();
            if !content.trim().is_empty() {
                system_parts.push(content);
            }
            continue;
        }

        wire_messages.push(WireMessage {
            role: message.role,
            content: serialize_message_content(message.content)?,
        });
    }

    let system = system_parts
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();

    Ok((
        (!system.is_empty()).then_some(system.join("\n\n")),
        wire_messages,
    ))
}

fn serialize_message_content(content: ProviderChatMessageContent) -> AppResult<Value> {
    match content {
        ProviderChatMessageContent::Text(text) => Ok(json!(text)),
        ProviderChatMessageContent::Parts(parts) => {
            let mut blocks = Vec::new();
            for part in parts {
                match part {
                    ProviderMessageContentPart::Text { text } => {
                        blocks.push(json!({
                            "type": "text",
                            "text": text,
                        }));
                    }
                    ProviderMessageContentPart::ImageUrl { image_url } => {
                        let (media_type, data) = parse_data_url(&image_url.url)?;
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": data,
                            }
                        }));
                    }
                }
            }
            Ok(Value::Array(blocks))
        }
    }
}

fn parse_data_url(url: &str) -> AppResult<(String, String)> {
    let payload = url
        .strip_prefix("data:")
        .ok_or_else(|| AppError::Validation("anthropic image input must be a data URL".to_string()))?;
    let (meta, data) = payload
        .split_once(',')
        .ok_or_else(|| AppError::Validation("anthropic image input data URL was invalid".to_string()))?;
    let media_type = meta
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Validation("anthropic image input missing media type".to_string()))?;
    if !meta.contains(";base64") {
        return Err(AppError::Validation(
            "anthropic image input must be base64 encoded".to_string(),
        ));
    }
    Ok((media_type.to_string(), data.to_string()))
}

fn normalize_response(content: Vec<ResponseContentBlock>) -> AppResult<ProviderChatMessageResponse> {
    let mut text = Vec::new();
    let mut reasoning = Vec::new();
    let mut tool_calls = Vec::new();

    for block in content {
        match block {
            ResponseContentBlock::Text { text: value } => {
                if !value.is_empty() {
                    text.push(value);
                }
            }
            ResponseContentBlock::Thinking { thinking } => {
                if !thinking.is_empty() {
                    reasoning.push(thinking);
                }
            }
            ResponseContentBlock::ToolUse { id, name, input } => {
                tool_calls.push(ProviderToolCall {
                    id: Some(id),
                    name,
                    arguments: serde_json::to_string(&input)?,
                });
            }
            ResponseContentBlock::Unknown => {}
        }
    }

    Ok(ProviderChatMessageResponse {
        content: text.join("\n").trim_end_matches('\0').to_string(),
        reasoning_content: reasoning.join("\n"),
        tool_calls,
    })
}

fn serialize_tool_choice(choice: ProviderToolChoice) -> Value {
    match choice {
        ProviderToolChoice::Auto => json!({ "type": "auto" }),
        ProviderToolChoice::None => json!({ "type": "none" }),
        ProviderToolChoice::Required => json!({ "type": "any" }),
        ProviderToolChoice::Named(name) => json!({ "type": "tool", "name": name }),
    }
}

#[derive(Default)]
struct StreamStats {
    chunks: usize,
    bytes: usize,
    events: usize,
    delta_events: usize,
    delta_chars: usize,
}

fn process_stream_events<F>(
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
    events: Vec<SseEvent>,
    stats: &mut StreamStats,
    full_answer: &mut String,
    on_delta: &mut F,
) -> AppResult<()>
where
    F: FnMut(&str) -> AppResult<()>,
{
    for event in events {
        stats.events += 1;

        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_event",
                format!(
                    "kind={} provider=anthropic_messages event_index={} event_name={} data_chars={} data_preview={}",
                    request_kind,
                    stats.events,
                    event.event.as_deref().unwrap_or("-"),
                    event.data.chars().count(),
                    truncate_for_log(event.data.as_str(), PROVIDER_LOG_EVENT_PREVIEW_CHARS),
                ),
            );
        }

        let payload: StreamPayload = serde_json::from_str(&event.data).map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_event_parse_failed",
                    format!(
                        "kind={} provider=anthropic_messages event_index={} error={} data_preview={}",
                        request_kind,
                        stats.events,
                        error,
                        truncate_for_log(event.data.as_str(), PROVIDER_LOG_EVENT_PREVIEW_CHARS),
                    ),
                );
            }
            AppError::from(error)
        })?;

        if payload.type_name == "error" {
            return Err(AppError::Runtime(
                payload
                    .error
                    .map(|error| error.message)
                    .filter(|message| !message.is_empty())
                    .unwrap_or_else(|| "provider stream returned an error event".to_string()),
            ));
        }

        if payload.type_name != "content_block_delta" || payload.delta.type_name != "text_delta" {
            continue;
        }

        let Some(delta) = payload.delta.text else {
            continue;
        };
        if delta.is_empty() {
            continue;
        }

        stats.delta_events += 1;
        stats.delta_chars += delta.chars().count();
        on_delta(&delta)?;
        full_answer.push_str(&delta);
    }

    Ok(())
}

fn log_request(
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
    config: &AiConfig,
    messages: &[ProviderChatMessage],
    options: &ProviderChatRequestOptions,
    timeout: Duration,
) {
    let Some(log_context) = log_context else {
        return;
    };

    let endpoint = format!("{}/v1/messages", config.base_url.trim_end_matches('/'));
    log_context.append(
        "ai.provider.request",
        format!(
            "kind={} provider=anthropic_messages endpoint={} model={} timeout_ms={} temperature={} max_tokens={} max_context_tokens={} stream={} message_count={} tool_count={} tool_choice={} response_format={}",
            request_kind,
            endpoint,
            config.model,
            timeout.as_millis(),
            config.temperature,
            config.max_tokens,
            config.max_context_tokens,
            options.stream,
            messages.len(),
            options.tools.len(),
            describe_tool_choice(options.tool_choice.as_ref()),
            if options.response_format.is_some() { "ignored" } else { "unset" },
        ),
    );

    for (index, message) in messages.iter().enumerate() {
        log_context.append(
            "ai.provider.request_message",
            format!(
                "kind={} provider=anthropic_messages index={}/{} role={} chars={} part_count={} image_count={} preview={}",
                request_kind,
                index + 1,
                messages.len(),
                message.role,
                message.content.log_chars(),
                message.content.part_count(),
                message.content.image_count(),
                truncate_for_log(
                    message.content.text_preview().as_str(),
                    PROVIDER_LOG_MESSAGE_PREVIEW_CHARS
                ),
            ),
        );
    }

    for (index, tool) in options.tools.iter().enumerate() {
        log_context.append(
            "ai.provider.request_tool",
            format!(
                "kind={} provider=anthropic_messages index={}/{} name={} description={} schema_preview={}",
                request_kind,
                index + 1,
                options.tools.len(),
                tool.name,
                truncate_for_log(tool.description.as_str(), PROVIDER_LOG_TOOL_PREVIEW_CHARS),
                truncate_for_log(
                    tool.parameters.to_string().as_str(),
                    PROVIDER_LOG_TOOL_PREVIEW_CHARS
                ),
            ),
        );
    }
}

fn log_response_message(
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
    message: &ProviderChatMessageResponse,
) {
    let Some(log_context) = log_context else {
        return;
    };

    log_context.append(
        "ai.provider.response_message",
        format!(
            "kind={} provider=anthropic_messages content_chars={} reasoning_chars={} tool_calls={} content_preview={} reasoning_preview={}",
            request_kind,
            message.content.chars().count(),
            message.reasoning_content.chars().count(),
            message.tool_calls.len(),
            truncate_for_log(message.content.as_str(), PROVIDER_LOG_MESSAGE_PREVIEW_CHARS),
            truncate_for_log(
                message.reasoning_content.as_str(),
                PROVIDER_LOG_MESSAGE_PREVIEW_CHARS
            ),
        ),
    );

    for (index, tool_call) in message.tool_calls.iter().enumerate() {
        log_context.append(
            "ai.provider.response_tool_call",
            format!(
                "kind={} provider=anthropic_messages index={}/{} id={} name={} arguments_chars={} arguments_preview={}",
                request_kind,
                index + 1,
                message.tool_calls.len(),
                tool_call.id.as_deref().unwrap_or("-"),
                tool_call.name,
                tool_call.arguments.chars().count(),
                truncate_for_log(tool_call.arguments.as_str(), PROVIDER_LOG_TOOL_PREVIEW_CHARS),
            ),
        );
    }
}

fn describe_tool_choice(choice: Option<&ProviderToolChoice>) -> String {
    match choice {
        Some(ProviderToolChoice::Auto) => "auto".to_string(),
        Some(ProviderToolChoice::None) => "none".to_string(),
        Some(ProviderToolChoice::Required) => "required".to_string(),
        Some(ProviderToolChoice::Named(name)) => format!("named:{name}"),
        None => "unset".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_data_urls_for_anthropic_images() {
        let (media_type, data) = parse_data_url("data:image/png;base64,abcd").expect("data url");
        assert_eq!(media_type, "image/png");
        assert_eq!(data, "abcd");
    }

    #[test]
    fn normalizes_anthropic_tool_use_blocks() {
        let message = normalize_response(vec![
            ResponseContentBlock::Thinking {
                thinking: "internal".to_string(),
            },
            ResponseContentBlock::Text {
                text: "checking".to_string(),
            },
            ResponseContentBlock::ToolUse {
                id: "toolu_1".to_string(),
                name: "shell".to_string(),
                input: json!({ "command": "pwd" }),
            },
        ])
        .expect("normalize");

        assert_eq!(message.content, "checking");
        assert_eq!(message.reasoning_content, "internal");
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id.as_deref(), Some("toolu_1"));
    }
}
