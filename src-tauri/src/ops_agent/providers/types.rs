use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderChatMessage {
    pub role: String,
    pub content: String,
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
