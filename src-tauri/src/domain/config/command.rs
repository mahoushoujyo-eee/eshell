//! Tauri command surface for the config domain: SSH connection profiles,
//! host-key trust and the config reload bridge.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::common::error::to_command_error;
use crate::domain::config::{ConfigFile, ReloadOutcome};
use crate::domain::ssh::model::{SshConfig, SshConfigInput, SshKnownHost, TrustSshHostKeyInput};
use crate::state::AppState;

/// `reload_config` input. Omitting `file` reloads every reloadable file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadConfigInput {
    pub file: Option<String>,
}

/// One reloadable config file, as listed by `list_reloadable_configs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadableConfig {
    /// Wire name to pass back to `reload_config`.
    pub file: String,
    /// Path relative to the storage root, for display.
    pub path_hint: String,
}

/// Returns all stored SSH connection profiles.
#[tauri::command]
pub fn list_ssh_configs(state: State<'_, Arc<AppState>>) -> Result<Vec<SshConfig>, String> {
    Ok(state.storage.list_ssh_configs())
}

/// Creates or updates a single SSH connection profile.
#[tauri::command]
pub fn save_ssh_config(
    state: State<'_, Arc<AppState>>,
    input: SshConfigInput,
) -> Result<SshConfig, String> {
    state
        .storage
        .upsert_ssh_config(input)
        .map_err(to_command_error)
}

/// Deletes one SSH connection profile.
#[tauri::command]
pub fn delete_ssh_config(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state
        .storage
        .delete_ssh_config(&id)
        .map_err(to_command_error)
}

/// Stores or replaces a trusted SSH host key fingerprint.
#[tauri::command]
pub fn trust_ssh_host_key(
    state: State<'_, Arc<AppState>>,
    input: TrustSshHostKeyInput,
) -> Result<SshKnownHost, String> {
    state
        .storage
        .trust_ssh_host_key(input)
        .map_err(to_command_error)
}

/// Re-reads config files that were edited outside the app.
///
/// `input.file` selects one file; omitting it reloads every reloadable file.
/// A file that is missing leaves the current value alone, and a file that
/// fails to parse is reported in the outcome rather than applied, so a
/// half-written file cannot wipe the user's servers.
///
/// Reloading does not restart anything: an open SSH session keeps its
/// connection (a new profile applies to the next connection), and a running
/// ACP agent keeps its spawn settings until it is restarted.
#[tauri::command]
pub fn reload_config(
    state: State<'_, Arc<AppState>>,
    input: Option<ReloadConfigInput>,
) -> Result<Vec<ReloadOutcome>, String> {
    match input.and_then(|value| value.file) {
        Some(name) => {
            let file = ConfigFile::parse(&name).map_err(to_command_error)?;
            Ok(vec![state.storage.reload_config(file)])
        }
        None => Ok(state.storage.reload_all_configs()),
    }
}

/// The reloadable config files, for a caller that wants to offer a choice.
#[tauri::command]
pub fn list_reloadable_configs() -> Vec<ReloadableConfig> {
    reloadable_configs()
}

/// Shared by the Tauri command and the plugin broker, so both surfaces
/// report the same list.
pub fn reloadable_configs() -> Vec<ReloadableConfig> {
    ConfigFile::ALL
        .iter()
        .map(|file| ReloadableConfig {
            file: file_wire_name(*file).to_string(),
            path_hint: file.file_name().to_string(),
        })
        .collect()
}

fn file_wire_name(file: ConfigFile) -> &'static str {
    match file {
        ConfigFile::SshConfigs => "sshConfigs",
        ConfigFile::AcpAgents => "acpAgents",
        ConfigFile::Scripts => "scripts",
        ConfigFile::AgentContext => "agentContext",
    }
}

// ---------------------------------------------------------------------------
// Agent context (AGENTS.md) commands
// ---------------------------------------------------------------------------

/// Reads global or per-server AGENTS.md content stored on the local client.
#[tauri::command]
pub fn get_agent_context(
    state: State<'_, Arc<AppState>>,
    input: super::model::AgentContextInput,
) -> Result<super::model::AgentContextContent, String> {
    state
        .storage
        .get_agent_context(input.server_id.as_deref())
        .map_err(to_command_error)
}

/// Saves global or per-server AGENTS.md content stored on the local client.
#[tauri::command]
pub fn save_agent_context(
    state: State<'_, Arc<AppState>>,
    input: super::model::SaveAgentContextInput,
) -> Result<super::model::AgentContextContent, String> {
    state
        .storage
        .save_agent_context(input.server_id.as_deref(), &input.content)
        .map_err(to_command_error)
}

/// Lists the global plus one entry per stored SSH server agent context file.
#[tauri::command]
pub fn list_agent_context_files(
    state: State<'_, Arc<AppState>>,
) -> Result<super::model::AgentContextList, String> {
    state
        .storage
        .list_agent_context_files()
        .map_err(to_command_error)
}

/// Deletes a per-server AGENTS.md file (the global file is never deleted).
#[tauri::command]
pub fn delete_agent_context(
    state: State<'_, Arc<AppState>>,
    input: super::model::DeleteAgentContextInput,
) -> Result<(), String> {
    state
        .storage
        .delete_agent_context(Some(&input.server_id))
        .map_err(to_command_error)
}
