//! Discovery and import of AI profiles from other local tools.

use serde::{Deserialize, Serialize};

use super::ai::{AiApiType, AiProfile, AiProfilesState};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiImportSourceKind {
    ClaudeCode,
    Codex,
    CustomJson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiImportSource {
    pub id: String,
    pub kind: AiImportSourceKind,
    pub label: String,
    pub path: String,
    pub available: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiImportCandidate {
    pub source_id: String,
    pub source_kind: AiImportSourceKind,
    pub source_label: String,
    pub source_path: String,
    pub name: String,
    pub api_type: AiApiType,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub max_context_tokens: u32,
    pub system_prompt: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiImportSourcesInput {
    #[serde(default)]
    pub custom_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiImportSourcesResult {
    pub sources: Vec<AiImportSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectAiImportInput {
    pub source: AiImportSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DetectAiImportResult {
    pub candidates: Vec<AiImportCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAiProfilesInput {
    pub candidates: Vec<AiImportCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAiProfilesResult {
    pub state: AiProfilesState,
    pub imported: Vec<AiProfile>,
    pub skipped: Vec<String>,
}
