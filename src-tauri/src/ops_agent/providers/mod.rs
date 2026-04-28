use std::collections::HashSet;
use std::time::Duration;

use crate::error::AppResult;
use crate::models::{AiApiType, AiConfig};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;

use crate::ops_agent::domain::types::OpsAgentToolKind;

/// Provider protocol layer for ops_agent.
/// - `openai_compat`: OpenAI chat completions transport and parsing.
/// - `openai_responses`: OpenAI responses transport and parsing.
/// - `anthropic`: Anthropic messages transport and parsing.
pub mod anthropic;
pub mod openai_compat;
pub mod openai_responses;
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
        .request_message(
            config,
            messages,
            options,
            timeout,
            log_context,
            request_kind,
        )
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
