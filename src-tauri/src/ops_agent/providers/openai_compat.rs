use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::models::AiConfig;
use crate::ops_agent::stream::SseEventDecoder;

use super::types::{
    ProviderChatMessage, ProviderChatMessageResponse, ProviderChatRequestOptions,
    ProviderJsonSchema, ProviderResponseFormat, ProviderToolCall, ProviderToolChoice,
};

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
) -> AppResult<ProviderChatMessageResponse> {
    let response = build_client_request(config, messages, options, timeout)
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
    let message = body
        .choices
        .unwrap_or_default()
        .into_iter()
        .next()
        .map(|choice| normalize_choice_message(choice.message))
        .ok_or_else(|| {
            AppError::Runtime("ops agent AI response did not contain any choices".to_string())
        })?;

    if message.content.trim().is_empty()
        && message.reasoning_content.trim().is_empty()
        && message.tool_calls.is_empty()
    {
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
    mut on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    options.stream = true;
    let response = build_client_request(config, messages, options, timeout)
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
