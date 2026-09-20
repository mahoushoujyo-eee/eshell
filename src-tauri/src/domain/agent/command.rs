//! Tauri command surface for the agent domain: ACP agent lifecycle,
//! sessions, prompts, permission responses, session history and the MCP
//! bridge toolset injection happens inside `acp_agent_start`.

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    HttpHeader, McpServer, McpServerHttp, SessionConfigOption,
};

use crate::domain::agent::model::{
    find_config, load_agent_configs, lookup_runner, session_cwd_override, AcpAgentListEntry, AcpAgentStartInput, AcpAuthenticateInput, AcpHistoryMeta, AcpHistoryRecord, AcpHistoryIdInput, AcpAgentIdInput,
    AcpSessionCancelInput, AcpSessionNewInput, AcpSessionPromptInput, AcpSessionSetConfigOptionInput,
    AcpSessionSetModeInput, AcpPermissionRespondInput,
};
use crate::domain::agent::service::acp_client::{
    AcpPromptImage, AcpPromptResult, AcpSessionRunner, AcpStartInfo, TauriEventSink,
};
use crate::domain::agent::model::{config_option_value, history_dir, history_file_name};

#[tauri::command]
pub async fn acp_agent_list(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<Vec<AcpAgentListEntry>, String> {
    let configs =
        load_agent_configs(&state.storage.data_dir()).map_err(crate::common::error::to_command_error)?;
    let runners: HashMap<String, Arc<AcpSessionRunner>> = {
        let read = state.acp_agents.runners.read().unwrap();
        read.iter()
            .map(|(id, runner)| (id.clone(), Arc::clone(runner)))
            .collect()
    };
    let mut entries = Vec::with_capacity(configs.len());
    for config in configs {
        let running = match runners.get(&config.id) {
            Some(runner) => runner.is_running().await,
            None => false,
        };
        entries.push(AcpAgentListEntry {
            running,
            id: config.id.clone(),
            name: config.name.clone(),
            command: config.command.clone(),
            args: config.args.clone(),
            cwd: config.session_cwd().to_string_lossy().to_string(),
        });
    }
    Ok(entries)
}

/// Spawns one agent, handshakes, and creates (or resumes) its session.
/// Returns the session id plus the modes, capabilities, and agent info
/// advertised during the handshake.
#[tauri::command]
pub async fn acp_agent_start(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    app: tauri::AppHandle,
    input: AcpAgentStartInput,
) -> Result<AcpStartInfo, String> {
    let configs =
        load_agent_configs(&state.storage.data_dir()).map_err(crate::common::error::to_command_error)?;
    let config = find_config(&configs, &input.agent_id)
        .map_err(crate::common::error::to_command_error)?
        .clone();

    let runner = lookup_runner(&state.acp_agents, &config.id);
    if runner.is_running().await {
        return Err(format!(
            "acp agent `{}` already has an active session",
            config.id
        ));
    }

    let sink = Arc::new(TauriEventSink(app));
    let mut mcp_servers = config.mcp_servers.clone();
    // Give the agent eShell's own toolset (open sessions, remote exec, SFTP)
    // through the local MCP bridge, unless this agent opted out.
    if config.eshell_tools {
        if let Some(bridge) = state.mcp_bridge() {
            mcp_servers.push(McpServer::Http(
                McpServerHttp::new("eshell", format!("http://127.0.0.1:{}/mcp", bridge.port))
                    .headers(vec![HttpHeader::new(
                        "Authorization",
                        format!("Bearer {}", bridge.token),
                    )]),
            ));
        }
    }
    runner
        .start(
            config.to_acp_agent(),
            session_cwd_override(input.cwd.clone()).unwrap_or_else(|| config.session_cwd()),
            // The agent's own setting, so a later "no particular folder"
            // session (the panel's "Sessions" group) lands there.
            config.session_cwd(),
            mcp_servers,
            input.resume_session_id,
            sink,
        )
        .await
}

/// Stops one agent session and drops its runner entry.
#[tauri::command]
pub async fn acp_agent_stop(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpAgentIdInput,
) -> Result<(), String> {
    let runner = {
        let mut write = state.acp_agents.runners.write().unwrap();
        write.remove(&input.agent_id)
    };
    if let Some(runner) = runner {
        runner.stop().await;
    }
    Ok(())
}

/// Sends one prompt turn (text plus optional images) on an existing session.
#[tauri::command]
pub async fn acp_session_prompt(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionPromptInput,
) -> Result<AcpPromptResult, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    let images = input
        .images
        .into_iter()
        .map(|image| AcpPromptImage {
            data: image.data,
            mime_type: image.mime_type,
        })
        .collect();
    runner.prompt(&input.session_id, &input.text, images).await
}

/// Cancels the in-flight turn; pending permission requests resolve as cancelled.
#[tauri::command]
pub async fn acp_session_cancel(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionCancelInput,
) -> Result<(), String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.resolve_pending_permissions_cancelled();
    runner.cancel(&input.session_id).await
}

/// Opens a fresh session on the running agent process without restarting it
/// (login state and the spawn are reused). `cwd` switches the session to a
/// different project folder. The previous session's history has already been
/// persisted by the frontend before this is called.
#[tauri::command]
pub async fn acp_session_new(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionNewInput,
) -> Result<AcpStartInfo, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.new_session(session_cwd_override(input.cwd)).await
}

/// Resolves one pending permission request with the user's decision.
#[tauri::command]
pub async fn acp_permission_respond(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpPermissionRespondInput,
) -> Result<(), String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.respond_permission(&input.request_id, input.option_id.as_deref())
}

/// Switches the session mode.
#[tauri::command]
pub async fn acp_session_set_mode(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionSetModeInput,
) -> Result<(), String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.set_mode(&input.session_id, &input.mode_id).await
}

/// Sets one session config option (model, thought level, ...) and returns the
/// agent's full updated option set, which the panel swaps in wholesale.
#[tauri::command]
pub async fn acp_session_set_config_option(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpSessionSetConfigOptionInput,
) -> Result<Vec<SessionConfigOption>, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    let value = config_option_value(input.value).map_err(crate::common::error::to_command_error)?;
    runner
        .set_config_option(&input.session_id, &input.config_id, value)
        .await
}

/// Runs the agent's sign-in flow for one advertised auth method and, on
/// success, creates the session the initial start could not.
#[tauri::command]
pub async fn acp_agent_authenticate(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpAuthenticateInput,
) -> Result<AcpStartInfo, String> {
    let runner = get_runner(&state, &input.agent_id)?;
    runner.authenticate(&input.method_id).await
}


fn get_runner(
    state: &tauri::State<'_, Arc<crate::state::AppState>>,
    agent_id: &str,
) -> Result<Arc<AcpSessionRunner>, String> {
    let read = state.acp_agents.runners.read().unwrap();
    read.get(agent_id)
        .map(Arc::clone)
        .ok_or_else(|| format!("acp agent `{agent_id}` is not started"))
}
/// Persists (or overwrites) one session transcript.
#[tauri::command]
pub async fn acp_history_save(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: crate::domain::agent::model::AcpHistorySaveInput,
) -> Result<(), String> {
    let mut record = input.record;
    if record.id.trim().is_empty() {
        return Err("history record id is empty".to_string());
    }
    record.updated_at = crate::common::time::now_rfc3339();
    if record.created_at.trim().is_empty() {
        record.created_at = record.updated_at.clone();
    }

    let dir = crate::domain::agent::model::history_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(crate::domain::agent::model::history_file_name(&record.id));
    let serialized = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    std::fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))
}


#[tauri::command]
pub async fn acp_history_list(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<Vec<AcpHistoryMeta>, String> {
    let dir = history_dir(&state);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<AcpHistoryRecord>(&raw) else {
            continue;
        };
        rows.push(AcpHistoryMeta {
            entry_count: record.transcript.as_array().map(Vec::len).unwrap_or(0),
            id: record.id,
            agent_id: record.agent_id,
            agent_name: record.agent_name,
            title: record.title,
            created_at: record.created_at,
            updated_at: record.updated_at,
            project_id: record.project_id,
            cwd: record.cwd,
        });
    }
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

/// Loads one persisted session transcript.
#[tauri::command]
pub async fn acp_history_get(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpHistoryIdInput,
) -> Result<AcpHistoryRecord, String> {
    let path = history_dir(&state).join(history_file_name(&input.id));
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| format!("acp session history `{}` not found", input.id))?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Deletes one persisted session transcript.
#[tauri::command]
pub async fn acp_history_delete(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    input: AcpHistoryIdInput,
) -> Result<(), String> {
    let path = history_dir(&state).join(history_file_name(&input.id));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("delete {}: {err}", path.display())),
    }
}
