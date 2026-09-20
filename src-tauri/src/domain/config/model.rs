//! Wire types for the agent context (AGENTS.md) files, shared by the
//! config command surface and the storage layer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextInput {
    #[serde(default)]
    pub server_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentContextInput {
    #[serde(default)]
    pub server_id: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextContent {
    #[serde(default)]
    pub server_id: Option<String>,
    pub content: String,
    /// Whether the backing file already exists on disk.
    pub exists: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextFile {
    #[serde(default)]
    pub server_id: Option<String>,
    pub exists: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextList {
    pub global: AgentContextFile,
    pub servers: Vec<AgentContextFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentContextInput {
    pub server_id: String,
}
