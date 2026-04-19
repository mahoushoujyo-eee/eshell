use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderChatMessage {
    pub role: String,
    pub content: ProviderChatMessageContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ProviderChatMessageContent {
    Text(String),
    Parts(Vec<ProviderMessageContentPart>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderMessageContentPart {
    Text { text: String },
    ImageUrl { image_url: ProviderImageUrlPart },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderImageUrlPart {
    pub url: String,
}

impl ProviderChatMessageContent {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    pub fn log_chars(&self) -> usize {
        match self {
            Self::Text(value) => value.chars().count(),
            Self::Parts(parts) => parts
                .iter()
                .map(|part| match part {
                    ProviderMessageContentPart::Text { text } => text.chars().count(),
                    ProviderMessageContentPart::ImageUrl { image_url } => image_url.url.len(),
                })
                .sum(),
        }
    }

    pub fn text_preview(&self) -> String {
        match self {
            Self::Text(value) => value.clone(),
            Self::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    ProviderMessageContentPart::Text { text } => Some(text.as_str()),
                    ProviderMessageContentPart::ImageUrl { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        }
    }

    pub fn image_count(&self) -> usize {
        match self {
            Self::Text(_) => 0,
            Self::Parts(parts) => parts
                .iter()
                .filter(|part| matches!(part, ProviderMessageContentPart::ImageUrl { .. }))
                .count(),
        }
    }

    pub fn part_count(&self) -> usize {
        match self {
            Self::Text(_) => 1,
            Self::Parts(parts) => parts.len(),
        }
    }
}

impl From<String> for ProviderChatMessageContent {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&str> for ProviderChatMessageContent {
    fn from(value: &str) -> Self {
        Self::Text(value.to_string())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ProviderToolChoice {
    Auto,
    None,
    Required,
    Named(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderJsonSchema {
    pub name: String,
    pub schema: Value,
    pub strict: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum ProviderResponseFormat {
    JsonObject,
    JsonSchema(ProviderJsonSchema),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProviderChatRequestOptions {
    pub tools: Vec<ProviderToolDefinition>,
    pub tool_choice: Option<ProviderToolChoice>,
    pub response_format: Option<ProviderResponseFormat>,
    pub stream: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderToolCall {
    pub id: Option<String>,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProviderChatMessageResponse {
    pub content: String,
    pub reasoning_content: String,
    pub tool_calls: Vec<ProviderToolCall>,
}
