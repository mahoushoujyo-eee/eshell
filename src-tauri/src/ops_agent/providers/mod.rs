use std::collections::HashSet;
use std::time::Duration;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::{AiApiType, AiConfig};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;

use crate::ops_agent::domain::types::{OpsAgentToolKind, PlannedAgentReply, PlannedToolAction};

/// Provider protocol layer for ops_agent.
/// - `openai_compat`: OpenAI chat completions transport and parsing.
/// - `openai_responses`: OpenAI responses transport and parsing.
/// - `anthropic`: Anthropic messages transport and parsing.
/// - `text_fallback`: string-based fallback planner parsing for weakly-compatible vendors.
pub mod anthropic;
pub mod openai_compat;
pub mod openai_responses;
pub mod text_fallback;
pub mod types;

pub use types::{
    ProviderChatMessage, ProviderChatMessageContent, ProviderChatMessageResponse,
    ProviderChatRequestOptions, ProviderImageUrlPart, ProviderMessageContentPart,
    ProviderToolChoice, ProviderToolDefinition,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderInterface {
    OpenAiChatCompletions,
    OpenAiResponses,
    AnthropicMessages,
}

impl ProviderInterface {
    pub fn from_config(config: &AiConfig) -> Self {
        match config.api_type {
            AiApiType::OpenAiChatCompletions => Self::OpenAiChatCompletions,
            AiApiType::OpenAiResponses => Self::OpenAiResponses,
            AiApiType::AnthropicMessages => Self::AnthropicMessages,
        }
    }

    pub async fn request_message(
        self,
        config: &AiConfig,
        messages: Vec<ProviderChatMessage>,
        options: ProviderChatRequestOptions,
        timeout: Duration,
        log_context: Option<OpsAgentLogContext<'_>>,
        request_kind: &str,
    ) -> AppResult<ProviderChatMessageResponse> {
        match self {
            Self::OpenAiChatCompletions => {
                openai_compat::request_message(
                    config,
                    messages,
                    options,
                    timeout,
                    log_context,
                    request_kind,
                )
                .await
            }
            Self::OpenAiResponses => {
                openai_responses::request_message(
                    config,
                    messages,
                    options,
                    timeout,
                    log_context,
                    request_kind,
                )
                .await
            }
            Self::AnthropicMessages => {
                anthropic::request_message(
                    config,
                    messages,
                    options,
                    timeout,
                    log_context,
                    request_kind,
                )
                .await
            }
        }
    }

    pub async fn stream_message<F>(
        self,
        config: &AiConfig,
        messages: Vec<ProviderChatMessage>,
        options: ProviderChatRequestOptions,
        timeout: Duration,
        log_context: Option<OpsAgentLogContext<'_>>,
        request_kind: &str,
        on_delta: F,
    ) -> AppResult<String>
    where
        F: FnMut(&str) -> AppResult<()>,
    {
        match self {
            Self::OpenAiChatCompletions => {
                openai_compat::stream_message(
                    config,
                    messages,
                    options,
                    timeout,
                    log_context,
                    request_kind,
                    on_delta,
                )
                .await
            }
            Self::OpenAiResponses => {
                openai_responses::stream_message(
                    config,
                    messages,
                    options,
                    timeout,
                    log_context,
                    request_kind,
                    on_delta,
                )
                .await
            }
            Self::AnthropicMessages => {
                anthropic::stream_message(
                    config,
                    messages,
                    options,
                    timeout,
                    log_context,
                    request_kind,
                    on_delta,
                )
                .await
            }
        }
    }
}

pub async fn request_message(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    options: ProviderChatRequestOptions,
    timeout: Duration,
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
) -> AppResult<ProviderChatMessageResponse> {
    ProviderInterface::from_config(config)
        .request_message(config, messages, options, timeout, log_context, request_kind)
        .await
}

pub async fn stream_message<F>(
    config: &AiConfig,
    messages: Vec<ProviderChatMessage>,
    options: ProviderChatRequestOptions,
    timeout: Duration,
    log_context: Option<OpsAgentLogContext<'_>>,
    request_kind: &str,
    on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
{
    ProviderInterface::from_config(config)
        .stream_message(
            config,
            messages,
            options,
            timeout,
            log_context,
            request_kind,
            on_delta,
        )
        .await
}

pub fn normalize_tool_kind_alias(
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

pub fn parse_planned_reply_from_native_tool_calls(
    response: &ProviderChatMessageResponse,
    registered_tools: &HashSet<String>,
) -> AppResult<Option<PlannedAgentReply>> {
    let Some(tool_call) = response.tool_calls.first() else {
        return Ok(None);
    };

    let kind = normalize_tool_kind_alias(OpsAgentToolKind::new(tool_call.name.clone()), registered_tools);
    if kind.is_none() || !registered_tools.contains(kind.as_str()) {
        return Err(AppError::Validation(format!(
            "tool {} is not registered",
            tool_call.name
        )));
    }

    let arguments: Value = serde_json::from_str(&tool_call.arguments).map_err(|error| {
        AppError::Runtime(format!(
            "planner tool arguments for {} were not valid JSON: {error}",
            tool_call.name
        ))
    })?;
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let reason = arguments
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let normalized_command = if kind == OpsAgentToolKind::ui_context() {
        Some(command.unwrap_or_default())
    } else {
        command
    };
    if kind != OpsAgentToolKind::ui_context() && normalized_command.is_none() {
        return Err(AppError::Validation(format!(
            "planner tool {} did not include a command",
            tool_call.name
        )));
    }

    Ok(Some(PlannedAgentReply {
        reply: response.content.trim().to_string(),
        tool: PlannedToolAction {
            kind,
            command: normalized_command,
            reason,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops_agent::providers::types::ProviderToolCall;

    #[test]
    fn parses_native_tool_call_into_plan() {
        let response = ProviderChatMessageResponse {
            content: "正在检查".to_string(),
            reasoning_content: String::new(),
            tool_calls: vec![ProviderToolCall {
                id: Some("call-1".to_string()),
                name: "shell".to_string(),
                arguments: r#"{"command":"ls -la","reason":"inspect files"}"#.to_string(),
            }],
        };
        let registered = [OpsAgentToolKind::shell().to_string()]
            .into_iter()
            .collect::<HashSet<_>>();

        let plan = parse_planned_reply_from_native_tool_calls(&response, &registered)
            .expect("parse tool call")
            .expect("tool call plan");

        assert_eq!(plan.reply, "正在检查");
        assert_eq!(plan.tool.kind, OpsAgentToolKind::shell());
        assert_eq!(plan.tool.command.as_deref(), Some("ls -la"));
        assert_eq!(plan.tool.reason.as_deref(), Some("inspect files"));
    }
}
