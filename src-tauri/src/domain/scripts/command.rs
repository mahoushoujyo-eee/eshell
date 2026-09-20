//! Tauri command surface for the scripts domain: CRUD on saved script
//! definitions and execution of one script in a shell tab.

use std::sync::Arc;

use tauri::State;

use crate::common::error::to_command_error;
use crate::domain::scripts::model::{RunScriptInput, RunScriptResult, ScriptDefinition, ScriptInput};
use crate::state::AppState;

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

/// Executes one saved script in selected shell tab.
///
/// Priority:
/// - If script.command is provided, execute it directly.
/// - Otherwise execute `bash <script.path>`.
#[tauri::command]
pub async fn run_script(
    state: State<'_, Arc<AppState>>,
    input: RunScriptInput,
) -> Result<RunScriptResult, String> {
    let app_state = Arc::clone(state.inner());
    // Storage lookup is synchronous in-memory work; only the remote execution
    // is async, so it is awaited directly instead of being wrapped.
    let script = app_state
        .storage
        .find_script(&input.script_id)
        .map_err(to_command_error)?;
    let command = if script.command.trim().is_empty() {
        format!("bash {}", shell_quote(&script.path))
    } else {
        script.command.clone()
    };
    let execution =
        crate::domain::ssh::service::execute_command(&app_state, &input.session_id, &command)
            .await
            .map_err(to_command_error)?;
    Ok(RunScriptResult {
        script_id: script.id,
        script_name: script.name,
        execution,
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
