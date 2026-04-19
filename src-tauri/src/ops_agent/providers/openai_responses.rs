use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;
use crate::ops_agent::infrastructure::logging::{truncate_for_log, OpsAgentLogContext};
use crate::ops_agent::transport::stream::{SseEvent, SseEventDecoder};

use super::types::{
    ProviderChatMessage, ProviderChatMessageContent, ProviderChatMessageResponse,
    ProviderChatRequestOptions, ProviderJsonSchema, ProviderMessageContentPart,
    ProviderResponseFormat, ProviderToolCall, ProviderToolChoice,
};

const PROVIDER_LOG_MESSAGE_PREVIEW_CHARS: usize = 320;
const PROVIDER_LOG_TOOL_PREVIEW_CHARS: usize = 220;
const PROVIDER_LOG_BODY_PREVIEW_CHARS: usize = 640;
const PROVIDER_LOG_EVENT_PREVIEW_CHARS: usize = 220;

#[derive(Debug, Serialize)]
struct ResponsesRequest {
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<Vec<WireInputMessage>>,
    temperature: f64,
    max_output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<WireToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Serialize)]
struct WireInputMessage {
    role: String,
    content: Vec<WireInputContentPart>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum WireInputContentPart {
    #[serde(rename = "input_text")]
    InputText { text: String },
    #[serde(rename = "output_text")]
    OutputText { text: String },
    #[serde(rename = "input_image")]
    InputImage { image_url: String },
}

#[derive(Debug, Serialize)]
struct WireToolDefinition {
    #[serde(rename = "type")]
    type_name: String,
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Debug, Deserialize)]
struct ResponsesResponse {
    #[serde(default)]
    output: Vec<ResponseOutputItem>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponseOutputItem {
    #[serde(rename = "message")]
    Message {
        #[serde(default)]
        content: Vec<ResponseContentItem>,
    },
    #[serde(rename = "function_call")]
    FunctionCall {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        call_id: Option<String>,
        name: String,
        #[serde(default)]
        arguments: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponseContentItem {
    #[serde(rename = "output_text")]
    OutputText { text: String },
    #[serde(rename = "refusal")]
    Refusal {
        #[serde(default)]
        refusal: Option<String>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        #[serde(default)]
        summary: Vec<ResponseReasoningSummary>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct ResponseReasoningSummary {
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize, Default)]
struct StreamEventPayload {
    #[serde(rename = "type", default)]
    type_name: String,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    message: Option<String>,
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

    let response = build_client_request(config, messages, options, timeout)
        .send()
        .await
        .map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.http_error",
                    format!("kind={request_kind} provider=openai_responses error={error}"),
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
                    "kind={request_kind} provider=openai_responses status={status} content_length={:?} body_chars={} body_preview={}",
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
                format!("kind={request_kind} provider=openai_responses status={status} error={error}"),
            );
        }
        AppError::from(error)
    })?;
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.provider.response_body",
            format!(
                "kind={request_kind} provider=openai_responses status={status} content_length={:?} body_chars={} body_preview={}",
                content_length,
                raw_body.chars().count(),
                truncate_for_log(raw_body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
            ),
        );
    }

    let body: ResponsesResponse = serde_json::from_str(&raw_body).map_err(|error| {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_parse_failed",
                format!(
                    "kind={request_kind} provider=openai_responses status={status} error={} body_preview={}",
                    error,
                    truncate_for_log(raw_body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
                ),
            );
        }
        AppError::from(error)
    })?;

    let message = normalize_response(body.output);
    log_response_message(log_context, request_kind, &message);
    if message.content.trim().is_empty()
        && message.reasoning_content.trim().is_empty()
        && message.tool_calls.is_empty()
    {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_unusable",
                format!("kind={request_kind} provider=openai_responses status={status}"),
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

    let response = build_client_request(config, messages, options, timeout)
        .send()
        .await
        .map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_http_error",
                    format!("kind={request_kind} provider=openai_responses error={error}"),
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
                    "kind={request_kind} provider=openai_responses status={status} content_length={:?} body_chars={} body_preview={}",
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
                "kind={request_kind} provider=openai_responses status={status} content_length={:?}",
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
                    "kind={request_kind} provider=openai_responses status={status} chunks={} bytes={} error={error}",
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
                    "kind={request_kind} provider=openai_responses chunk_index={} bytes={}",
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
                    "kind={request_kind} provider=openai_responses chunks={} bytes={} events={} done_events={} delta_events={}",
                    stats.chunks,
                    stats.bytes,
                    stats.events,
                    stats.done_events,
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
                "kind={request_kind} provider=openai_responses chunks={} bytes={} events={} done_events={} delta_events={} delta_chars={} answer_chars={}",
                stats.chunks,
                stats.bytes,
                stats.events,
                stats.done_events,
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
) -> reqwest::RequestBuilder {
    let endpoint = format!("{}/responses", config.base_url.trim_end_matches('/'));
    let (instructions, input) = split_messages(messages);
    let payload = ResponsesRequest {
        model: config.model.clone(),
        instructions,
        input: (!input.is_empty()).then_some(input),
        temperature: config.temperature,
        max_output_tokens: config.max_tokens,
        tools: if options.tools.is_empty() {
            None
        } else {
            Some(
                options
                    .tools
                    .into_iter()
                    .map(|tool| WireToolDefinition {
                        type_name: "function".to_string(),
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    })
                    .collect(),
            )
        },
        tool_choice: options.tool_choice.map(serialize_tool_choice),
        text: options
            .response_format
            .map(|format| json!({ "format": serialize_response_format(format) })),
        stream: options.stream.then_some(true),
    };

    reqwest::Client::new()
        .post(endpoint)
        .timeout(timeout)
        .bearer_auth(&config.api_key)
        .json(&payload)
}

fn split_messages(messages: Vec<ProviderChatMessage>) -> (Option<String>, Vec<WireInputMessage>) {
    let mut instructions = Vec::new();
    let mut input = Vec::new();

    for message in messages {
        if message.role == "system" {
            let content = message.content.text_preview();
            if !content.trim().is_empty() {
                instructions.push(content);
            }
            continue;
        }

        input.push(WireInputMessage {
            content: serialize_message_content(message.role.as_str(), message.content),
            role: message.role,
        });
    }

    let instructions = instructions
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();

    (
        (!instructions.is_empty()).then_some(instructions.join("\n\n")),
        input,
    )
}

fn serialize_message_content(
    role: &str,
    content: ProviderChatMessageContent,
) -> Vec<WireInputContentPart> {
    match content {
        ProviderChatMessageContent::Text(text) => vec![serialize_text_part(role, text)],
        ProviderChatMessageContent::Parts(parts) => parts
            .into_iter()
            .filter_map(|part| match part {
                ProviderMessageContentPart::Text { text } => Some(serialize_text_part(role, text)),
                ProviderMessageContentPart::ImageUrl { image_url } => Some(
                    WireInputContentPart::InputImage {
                        image_url: image_url.url,
                    },
                ),
            })
            .collect(),
    }
}

fn serialize_text_part(role: &str, text: String) -> WireInputContentPart {
    if role == "assistant" {
        WireInputContentPart::OutputText { text }
    } else {
        WireInputContentPart::InputText { text }
    }
}

fn normalize_response(output: Vec<ResponseOutputItem>) -> ProviderChatMessageResponse {
    let mut content = Vec::new();
    let mut reasoning = Vec::new();
    let mut tool_calls = Vec::new();

    for item in output {
        match item {
            ResponseOutputItem::Message { content: blocks } => {
                for block in blocks {
                    match block {
                        ResponseContentItem::OutputText { text } => {
                            if !text.is_empty() {
                                content.push(text);
                            }
                        }
                        ResponseContentItem::Refusal { refusal } => {
                            if let Some(refusal) = refusal {
                                if !refusal.is_empty() {
                                    content.push(refusal);
                                }
                            }
                        }
                        ResponseContentItem::Reasoning { summary } => {
                            for item in summary {
                                if !item.text.is_empty() {
                                    reasoning.push(item.text);
                                }
                            }
                        }
                        ResponseContentItem::Unknown => {}
                    }
                }
            }
            ResponseOutputItem::FunctionCall {
                id,
                call_id,
                name,
                arguments,
            } => {
                tool_calls.push(ProviderToolCall {
                    id: call_id.or(id),
                    name,
                    arguments,
                });
            }
            ResponseOutputItem::Unknown => {}
        }
    }

    ProviderChatMessageResponse {
        content: content.join("\n").trim_end_matches('\0').to_string(),
        reasoning_content: reasoning.join("\n"),
        tool_calls,
    }
}

fn serialize_tool_choice(choice: ProviderToolChoice) -> Value {
    match choice {
        ProviderToolChoice::Auto => json!("auto"),
        ProviderToolChoice::None => json!("none"),
        ProviderToolChoice::Required => json!("required"),
        ProviderToolChoice::Named(name) => json!({ "type": "function", "name": name }),
    }
}

fn serialize_response_format(format: ProviderResponseFormat) -> Value {
    match format {
        ProviderResponseFormat::JsonObject => json!({ "type": "json_object" }),
        ProviderResponseFormat::JsonSchema(ProviderJsonSchema {
            name,
            schema,
            strict,
        }) => json!({
            "type": "json_schema",
            "name": name,
            "schema": schema,
            "strict": strict,
        }),
    }
}

#[derive(Default)]
struct StreamStats {
    chunks: usize,
    bytes: usize,
    events: usize,
    done_events: usize,
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
        if event.data == "[DONE]" {
            stats.done_events += 1;
            continue;
        }

        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_event",
                format!(
                    "kind={} provider=openai_responses event_index={} event_name={} data_chars={} data_preview={}",
                    request_kind,
                    stats.events,
                    event.event.as_deref().unwrap_or("-"),
                    event.data.chars().count(),
                    truncate_for_log(event.data.as_str(), PROVIDER_LOG_EVENT_PREVIEW_CHARS),
                ),
            );
        }

        let payload: StreamEventPayload = serde_json::from_str(&event.data).map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_event_parse_failed",
                    format!(
                        "kind={} provider=openai_responses event_index={} error={} data_preview={}",
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
                payload.message.unwrap_or_else(|| "provider stream returned an error event".to_string()),
            ));
        }

        if payload.type_name != "response.output_text.delta" {
            continue;
        }

        let Some(delta) = payload.delta else {
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

    let endpoint = format!("{}/responses", config.base_url.trim_end_matches('/'));
    log_context.append(
        "ai.provider.request",
        format!(
            "kind={} provider=openai_responses endpoint={} model={} timeout_ms={} temperature={} max_tokens={} max_context_tokens={} stream={} message_count={} tool_count={} tool_choice={} response_format={}",
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
            describe_response_format(options.response_format.as_ref()),
        ),
    );

    for (index, message) in messages.iter().enumerate() {
        log_context.append(
            "ai.provider.request_message",
            format!(
                "kind={} provider=openai_responses index={}/{} role={} chars={} part_count={} image_count={} preview={}",
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
                "kind={} provider=openai_responses index={}/{} name={} description={} schema_preview={}",
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
            "kind={} provider=openai_responses content_chars={} reasoning_chars={} tool_calls={} content_preview={} reasoning_preview={}",
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
                "kind={} provider=openai_responses index={}/{} id={} name={} arguments_chars={} arguments_preview={}",
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

fn describe_response_format(format: Option<&ProviderResponseFormat>) -> String {
    match format {
        Some(ProviderResponseFormat::JsonObject) => "json_object".to_string(),
        Some(ProviderResponseFormat::JsonSchema(schema)) => {
            format!("json_schema:{}:strict={}", schema.name, schema.strict)
        }
        None => "unset".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_responses_output_text_and_tool_calls() {
        let message = normalize_response(vec![
            ResponseOutputItem::Message {
                content: vec![
                    ResponseContentItem::Reasoning {
                        summary: vec![ResponseReasoningSummary {
                            text: "internal".to_string(),
                        }],
                    },
                    ResponseContentItem::OutputText {
                        text: "checking".to_string(),
                    },
                ],
            },
            ResponseOutputItem::FunctionCall {
                id: Some("fc_1".to_string()),
                call_id: Some("call_1".to_string()),
                name: "shell".to_string(),
                arguments: "{}".to_string(),
            },
        ]);

        assert_eq!(message.content, "checking");
        assert_eq!(message.reasoning_content, "internal");
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id.as_deref(), Some("call_1"));
    }

    #[test]
    fn serializes_named_tool_choice_for_responses() {
        assert_eq!(
            serialize_tool_choice(ProviderToolChoice::Named("probe".to_string())),
            json!({ "type": "function", "name": "probe" })
        );
    }

    #[test]
    fn serializes_assistant_history_as_output_text() {
        let part = serialize_message_content(
            "assistant",
            ProviderChatMessageContent::Text("hello".to_string()),
        );
        let payload = serde_json::to_value(&part).expect("serialize");

        assert_eq!(payload, json!([{ "type": "output_text", "text": "hello" }]));
    }
}
