//! Saved scripts and their parameters.

use serde::{Deserialize, Serialize};

use super::shell::CommandExecutionResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDefinition {
    pub id: String,
    pub name: String,
    pub path: String,
    pub command: String,
    pub description: String,
    #[serde(default)]
    pub parameters: Vec<ScriptParameter>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptParameter {
    pub name: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub default_value: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default = "default_script_parameter_quote")]
    pub quote: bool,
}

pub fn default_script_parameter_quote() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInput {
    pub id: Option<String>,
    pub name: String,
    pub path: Option<String>,
    pub command: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: Vec<ScriptParameter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptInput {
    pub session_id: String,
    pub script_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptResult {
    pub script_id: String,
    pub script_name: String,
    pub execution: CommandExecutionResult,
}
