use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;
use crate::ops_agent::infrastructure::logging::{truncate_for_log, OpsAgentLogContext};
use crate::ops_agent::transport::stream::{SseEvent, SseEventDecoder};

use super::types::{
    ProviderChatMessage, ProviderChatMessageResponse, ProviderChatRequestOptions,
    ProviderJsonSchema, ProviderResponseFormat, ProviderToolCall, ProviderToolChoice,
};

const PROVIDER_LOG_MESSAGE_PREVIEW_CHARS: usize = 320;
const PROVIDER_LOG_TOOL_PREVIEW_CHARS: usize = 220;
const PROVIDER_LOG_BODY_PREVIEW_CHARS: usize = 640;
const PROVIDER_LOG_EVENT_PREVIEW_CHARS: usize = 220;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<ProviderChatMessage>,
    temperature: f64,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<WireToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Serialize)]
struct WireToolDefinition {
    #[serde(rename = "type")]
    type_name: String,
    function: WireFunctionDefinition,
}

#[derive(Debug, Serialize)]
struct WireFunctionDefinition {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsResponse {
    #[serde(default)]
    choices: Option<Vec<Choice>>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ChoiceToolCall>>,
    #[serde(default)]
    function_call: Option<LegacyFunctionCall>,
}

#[derive(Debug, Deserialize)]
struct ChoiceToolCall {
    #[serde(default)]
    id: Option<String>,
    function: ChoiceFunctionCall,
}

#[derive(Debug, Deserialize)]
struct ChoiceFunctionCall {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct LegacyFunctionCall {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsStreamResponse {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
}

#[derive(Debug, Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
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
                    format!("kind={request_kind} error={error}"),
                );
            }
            AppError::from(error)
        })?;
    let status = response.status();
    let content_length = response.content_length();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_failed",
                format!(
                    "kind={request_kind} status={status} content_length={:?} body_chars={} body_preview={}",
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
                format!("kind={request_kind} status={status} error={error}"),
            );
        }
        AppError::from(error)
    })?;
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.provider.response_body",
            format!(
                "kind={request_kind} status={status} content_length={:?} body_chars={} body_preview={}",
                content_length,
                raw_body.chars().count(),
                truncate_for_log(raw_body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
            ),
        );
    }
    let body: ChatCompletionsResponse = serde_json::from_str(&raw_body).map_err(|error| {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_parse_failed",
                format!(
                    "kind={request_kind} status={status} error={} body_preview={}",
                    error,
                    truncate_for_log(raw_body.as_str(), PROVIDER_LOG_BODY_PREVIEW_CHARS)
                ),
            );
        }
        AppError::from(error)
    })?;
    let choices = body.choices.unwrap_or_default();
    if let Some(log_context) = log_context {
        log_context.append(
            "ai.provider.response_choices",
            format!("kind={request_kind} status={status} choices={}", choices.len()),
        );
    }
    let message = choices
        .into_iter()
        .next()
        .map(|choice| normalize_choice_message(choice.message))
        .ok_or_else(|| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.response_empty_choices",
                    format!("kind={request_kind} status={status}"),
                );
            }
            AppError::Runtime("ops agent AI response did not contain any choices".to_string())
        })?;
    log_response_message(log_context, request_kind, &message);

    if message.content.trim().is_empty()
        && message.reasoning_content.trim().is_empty()
        && message.tool_calls.is_empty()
    {
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.response_unusable",
                format!("kind={request_kind} status={status}"),
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
                    format!("kind={request_kind} error={error}"),
                );
            }
            AppError::from(error)
        })?;
    let status = response.status();
    let content_length = response.content_length();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_failed",
                format!(
                    "kind={request_kind} status={status} content_length={:?} body_chars={} body_preview={}",
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
                "kind={request_kind} status={status} content_length={:?}",
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
                    "kind={request_kind} status={status} chunks={} bytes={} error={error}",
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
                    "kind={request_kind} chunk_index={} bytes={}",
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
                    "kind={request_kind} chunks={} bytes={} events={} done_events={} delta_events={}",
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
                "kind={request_kind} chunks={} bytes={} events={} done_events={} delta_events={} delta_chars={} answer_chars={}",
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
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let payload = ChatCompletionsRequest {
        model: config.model.clone(),
        messages,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        tools: if options.tools.is_empty() {
            None
        } else {
            Some(
                options
                    .tools
                    .into_iter()
                    .map(|tool| WireToolDefinition {
                        type_name: "function".to_string(),
                        function: WireFunctionDefinition {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.parameters,
                        },
                    })
                    .collect(),
            )
        },
        tool_choice: options.tool_choice.map(serialize_tool_choice),
        response_format: options.response_format.map(serialize_response_format),
        stream: options.stream.then_some(true),
    };

    reqwest::Client::new()
        .post(endpoint)
        .timeout(timeout)
        .bearer_auth(&config.api_key)
        .json(&payload)
}

fn normalize_choice_message(message: ChoiceMessage) -> ProviderChatMessageResponse {
    let mut tool_calls = message
        .tool_calls
        .unwrap_or_default()
        .into_iter()
        .map(|tool_call| ProviderToolCall {
            id: tool_call.id,
            name: tool_call.function.name,
            arguments: tool_call.function.arguments,
        })
        .collect::<Vec<_>>();

    if tool_calls.is_empty() {
        if let Some(function_call) = message.function_call {
            tool_calls.push(ProviderToolCall {
                id: None,
                name: function_call.name,
                arguments: function_call.arguments,
            });
        }
    }

    ProviderChatMessageResponse {
        content: message.content.unwrap_or_default().trim_end_matches('\0').to_string(),
        reasoning_content: message.reasoning_content.unwrap_or_default(),
        tool_calls,
    }
}

fn serialize_tool_choice(choice: ProviderToolChoice) -> Value {
    match choice {
        ProviderToolChoice::Auto => json!("auto"),
        ProviderToolChoice::None => json!("none"),
        ProviderToolChoice::Required => json!("required"),
        ProviderToolChoice::Named(name) => {
            json!({ "type": "function", "function": { "name": name } })
        }
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
            "json_schema": {
                "name": name,
                "strict": strict,
                "schema": schema,
            }
        }),
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

#[derive(Default)]
struct StreamStats {
    chunks: usize,
    bytes: usize,
    events: usize,
    done_events: usize,
    delta_events: usize,
    delta_chars: usize,
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

    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    log_context.append(
        "ai.provider.request",
        format!(
            "kind={} endpoint={} model={} timeout_ms={} temperature={} max_tokens={} max_context_tokens={} stream={} message_count={} tool_count={} tool_choice={} response_format={}",
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
                "kind={} index={}/{} role={} chars={} part_count={} image_count={} preview={}",
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
                "kind={} index={}/{} name={} description={} schema_preview={}",
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
            "kind={} content_chars={} reasoning_chars={} tool_calls={} content_preview={} reasoning_preview={}",
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
                "kind={} index={}/{} id={} name={} arguments_chars={} arguments_preview={}",
                request_kind,
                index + 1,
                message.tool_calls.len(),
                tool_call.id.as_deref().unwrap_or("-"),
                tool_call.name,
                tool_call.arguments.chars().count(),
                truncate_for_log(
                    tool_call.arguments.as_str(),
                    PROVIDER_LOG_TOOL_PREVIEW_CHARS
                ),
            ),
        );
    }
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
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_done",
                    format!(
                        "kind={} event_index={} event_name={}",
                        request_kind,
                        stats.events,
                        event.event.as_deref().unwrap_or("-")
                    ),
                );
            }
            continue;
        }

        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_event",
                format!(
                    "kind={} event_index={} event_name={} data_chars={} data_preview={}",
                    request_kind,
                    stats.events,
                    event.event.as_deref().unwrap_or("-"),
                    event.data.chars().count(),
                    truncate_for_log(event.data.as_str(), PROVIDER_LOG_EVENT_PREVIEW_CHARS),
                ),
            );
        }

        let delta = parse_stream_delta(&event.data).map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_event_parse_failed",
                    format!(
                        "kind={} event_index={} error={} data_preview={}",
                        request_kind,
                        stats.events,
                        error,
                        truncate_for_log(
                            event.data.as_str(),
                            PROVIDER_LOG_EVENT_PREVIEW_CHARS
                        )
                    ),
                );
            }
            error
        })?;

        let Some(delta) = delta else {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_event_ignored",
                    format!(
                        "kind={} event_index={} reason=no_content_delta",
                        request_kind, stats.events
                    ),
                );
            }
            continue;
        };

        if delta.is_empty() {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_event_ignored",
                    format!(
                        "kind={} event_index={} reason=empty_delta",
                        request_kind, stats.events
                    ),
                );
            }
            continue;
        }

        stats.delta_events += 1;
        stats.delta_chars += delta.chars().count();
        if let Some(log_context) = log_context {
            log_context.append(
                "ai.provider.stream_delta",
                format!(
                    "kind={} delta_index={} chars={} preview={}",
                    request_kind,
                    stats.delta_events,
                    delta.chars().count(),
                    truncate_for_log(delta.as_str(), PROVIDER_LOG_EVENT_PREVIEW_CHARS),
                ),
            );
        }
        on_delta(&delta).map_err(|error| {
            if let Some(log_context) = log_context {
                log_context.append(
                    "ai.provider.stream_delta_callback_failed",
                    format!(
                        "kind={} delta_index={} error={}",
                        request_kind, stats.delta_events, error
                    ),
                );
            }
            error
        })?;
        full_answer.push_str(&delta);
    }

    Ok(())
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
    fn serializes_named_tool_choice_to_openai_shape() {
        assert_eq!(
            serialize_tool_choice(ProviderToolChoice::Named("probe".to_string())),
            json!({ "type": "function", "function": { "name": "probe" } })
        );
    }

    #[test]
    fn normalizes_tool_calls_and_legacy_function_call() {
        let native = normalize_choice_message(ChoiceMessage {
            content: Some("checking".to_string()),
            reasoning_content: Some("internal".to_string()),
            tool_calls: Some(vec![ChoiceToolCall {
                id: Some("call-1".to_string()),
                function: ChoiceFunctionCall {
                    name: "shell".to_string(),
                    arguments: "{}".to_string(),
                },
            }]),
            function_call: None,
        });
        assert_eq!(native.tool_calls.len(), 1);
        assert_eq!(native.tool_calls[0].name, "shell");

        let legacy = normalize_choice_message(ChoiceMessage {
            content: None,
            reasoning_content: None,
            tool_calls: None,
            function_call: Some(LegacyFunctionCall {
                name: "shell".to_string(),
                arguments: "{}".to_string(),
            }),
        });
        assert_eq!(legacy.tool_calls.len(), 1);
        assert_eq!(legacy.tool_calls[0].name, "shell");
    }
}
