use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::to_command_error;
use crate::models::{
    AgentContextContent, AgentContextInput, AgentContextList, AiConfig, AiConfigInput,
    AiImportSource, AiImportSourceKind, AiImportSourcesInput, AiImportSourcesResult,
    AiProfileInput, AiProfilesState, DeleteAgentContextInput, DetectAiImportInput,
    DetectAiImportResult, ImportAiProfilesInput, ImportAiProfilesResult,
    SaveAgentContextInput, ScriptDefinition, ScriptInput, SetActiveAiProfileInput,
    SetAiAgentModeInput, SetAiApprovalModeInput, SshConfig, SshConfigInput, SshKnownHost,
    TrustSshHostKeyInput,
};
use crate::state::AppState;
use crate::storage::{ConfigFile, ReloadOutcome};

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

/// Lists all script definitions managed by user.
#[tauri::command]
pub fn list_scripts(state: State<'_, Arc<AppState>>) -> Result<Vec<ScriptDefinition>, String> {
    Ok(state.storage.list_scripts())
}

/// Creates or updates one script definition.
#[tauri::command]
pub fn save_script(
    state: State<'_, Arc<AppState>>,
    input: ScriptInput,
) -> Result<ScriptDefinition, String> {
    state.storage.upsert_script(input).map_err(to_command_error)
}

/// Deletes one script definition by id.
#[tauri::command]
pub fn delete_script(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_script(&id).map_err(to_command_error)
}

/// Returns AI provider configuration from persistent store.
#[tauri::command]
pub fn get_ai_config(state: State<'_, Arc<AppState>>) -> Result<AiConfig, String> {
    Ok(state.storage.get_ai_config())
}

/// Returns all persisted AI profiles and active profile id.
#[tauri::command]
pub fn list_ai_profiles(state: State<'_, Arc<AppState>>) -> Result<AiProfilesState, String> {
    Ok(state.storage.list_ai_profiles())
}

/// Creates or updates one AI profile.
#[tauri::command]
pub fn save_ai_profile(
    state: State<'_, Arc<AppState>>,
    input: AiProfileInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .save_ai_profile(input)
        .map_err(to_command_error)
}

/// Deletes one AI profile by id.
#[tauri::command]
pub fn delete_ai_profile(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .delete_ai_profile(&id)
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

/// Saves the global approval mode shared by every AI profile.
#[tauri::command]
pub fn save_ai_approval_mode(
    state: State<'_, Arc<AppState>>,
    input: SetAiApprovalModeInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .save_ai_approval_mode(input.approval_mode)
        .map_err(to_command_error)
}

/// Saves the global agent runtime mode shared by every AI profile.
#[tauri::command]
pub fn save_ai_agent_mode(
    state: State<'_, Arc<AppState>>,
    input: SetAiAgentModeInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .save_ai_agent_mode(input.agent_mode)
        .map_err(to_command_error)
}

/// Reads global or per-server AGENTS.md content stored on the local client.
#[tauri::command]
pub fn get_agent_context(
    state: State<'_, Arc<AppState>>,
    input: AgentContextInput,
) -> Result<AgentContextContent, String> {
    state
        .storage
        .get_agent_context(input.server_id.as_deref())
        .map_err(to_command_error)
}

/// Saves global or per-server AGENTS.md content stored on the local client.
#[tauri::command]
pub fn save_agent_context(
    state: State<'_, Arc<AppState>>,
    input: SaveAgentContextInput,
) -> Result<AgentContextContent, String> {
    state
        .storage
        .save_agent_context(input.server_id.as_deref(), &input.content)
        .map_err(to_command_error)
}

/// Lists the global plus one entry per stored SSH server agent context file.
#[tauri::command]
pub fn list_agent_context_files(
    state: State<'_, Arc<AppState>>,
) -> Result<AgentContextList, String> {
    state
        .storage
        .list_agent_context_files()
        .map_err(to_command_error)
}

/// Deletes a per-server AGENTS.md file (the global file is never deleted).
#[tauri::command]
pub fn delete_agent_context(
    state: State<'_, Arc<AppState>>,
    input: DeleteAgentContextInput,
) -> Result<(), String> {
    state
        .storage
        .delete_agent_context(Some(&input.server_id))
        .map_err(to_command_error)
}

/// Marks one AI profile as active for chat.
#[tauri::command]
pub fn set_active_ai_profile(
    state: State<'_, Arc<AppState>>,
    input: SetActiveAiProfileInput,
) -> Result<AiProfilesState, String> {
    state
        .storage
        .set_active_ai_profile(&input.id)
        .map_err(to_command_error)
}

/// Saves AI provider configuration.
#[tauri::command]
pub fn save_ai_config(
    state: State<'_, Arc<AppState>>,
    input: AiConfigInput,
) -> Result<AiConfig, String> {
    state
        .storage
        .save_ai_config(input)
        .map_err(to_command_error)
}

/// Returns AI import sources the user can pick from, including well-known CLI tools.
#[tauri::command]
pub fn list_ai_import_sources(
    state: State<'_, Arc<AppState>>,
    input: Option<AiImportSourcesInput>,
) -> Result<AiImportSourcesResult, String> {
    let custom_paths = input
        .map(|payload| payload.custom_paths)
        .unwrap_or_default();
    for path in &custom_paths {
        crate::storage::ai_import::read_custom_path_for_detection(path).map_err(to_command_error)?;
    }
    Ok(AiImportSourcesResult {
        sources: state.storage.list_ai_import_sources(&custom_paths),
    })
}

/// Reads a single AI import source and returns candidate profiles the user can import.
#[tauri::command]
pub fn detect_ai_import_candidates(
    state: State<'_, Arc<AppState>>,
    input: DetectAiImportInput,
) -> Result<DetectAiImportResult, String> {
    let AiImportSource {
        id,
        kind,
        label,
        path,
        available,
        note,
    } = input.source;
    if !available {
        return Err(format!(
            "import source {label} is not available: {}",
            note.unwrap_or_default()
        ));
    }
    let source = AiImportSource {
        id,
        kind: kind.clone(),
        label,
        path,
        available: true,
        note: None,
    };
    let (candidates, warnings) = state
        .storage
        .detect_ai_import_candidates(&source)
        .map_err(to_command_error)?;
    Ok(DetectAiImportResult {
        candidates,
        warnings,
    })
}

/// Persists the selected import candidates as new AI profiles.
#[tauri::command]
pub fn import_ai_profiles(
    state: State<'_, Arc<AppState>>,
    input: ImportAiProfilesInput,
) -> Result<ImportAiProfilesResult, String> {
    state
        .storage
        .import_ai_profiles(input.candidates)
        .map_err(to_command_error)
}

/// Normalises an AI import source kind to keep frontend enums in sync.
#[tauri::command]
pub fn ai_import_source_kind_label(kind: AiImportSourceKind) -> String {
    match kind {
        AiImportSourceKind::ClaudeCode => "Claude Code".to_string(),
        AiImportSourceKind::Codex => "Codex".to_string(),
        AiImportSourceKind::CustomJson => "Custom".to_string(),
    }
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
        ConfigFile::AiProfiles => "aiProfiles",
        ConfigFile::AgentContext => "agentContext",
    }
}
