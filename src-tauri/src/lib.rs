mod ai_service;
mod commands;
mod error;
mod mcp_bridge;
mod models;
mod ops_agent;
mod server_ops;
mod state;
mod storage;

#[cfg(not(test))]
use std::path::PathBuf;
#[cfg(not(test))]
use std::sync::Arc;

#[cfg(not(test))]
use state::AppState;

/// Application bootstrap entry.
///
/// Runtime behavior:
/// - Creates persistent storage under `.eshell-data` in current working directory.
/// - Registers all Tauri commands used by frontend.
/// - Starts Tauri event loop.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(not(test))]
pub fn run() {
    let storage_root = resolve_storage_root();
    let app_state = AppState::new(storage_root).expect("failed to initialize app state");
    let shared_state = Arc::new(app_state);
    let bridge_state = Arc::clone(&shared_state);

    tauri::Builder::default()
        .manage(shared_state)
        .setup(move |_app| {
            // Local MCP bridge: exposes eShell's sessions/SFTP as tools that
            // get injected into ACP agent sessions. Failure is non-fatal —
            // agents simply start without the eshell toolset.
            tauri::async_runtime::spawn(async move {
                if let Err(error) = mcp_bridge::start(bridge_state).await {
                    eprintln!("mcp bridge failed to start: {error}");
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::config::list_ssh_configs,
            commands::config::save_ssh_config,
            commands::config::delete_ssh_config,
            commands::config::trust_ssh_host_key,
            server_ops::commands::list_shell_sessions,
            server_ops::commands::open_shell_session,
            server_ops::commands::cancel_open_shell_session,
            server_ops::commands::close_shell_session,
            server_ops::commands::pty_write_input,
            server_ops::commands::pty_resize,
            server_ops::commands::execute_shell_command,
            server_ops::commands::sftp_list_dir,
            server_ops::commands::sftp_read_file,
            server_ops::commands::sftp_write_file,
            server_ops::commands::sftp_create_file,
            server_ops::commands::sftp_create_directory,
            server_ops::commands::sftp_upload_file,
            server_ops::commands::sftp_delete_entry,
            server_ops::commands::sftp_rename_entry,
            server_ops::commands::sftp_upload_file_with_progress,
            server_ops::commands::sftp_upload_local_file_with_progress,
            server_ops::commands::sftp_download_file,
            server_ops::commands::sftp_download_file_to_local,
            server_ops::commands::sftp_default_download_dir,
            server_ops::commands::sftp_cancel_transfer,
            server_ops::commands::ssh_ki_respond,
            server_ops::commands::fetch_server_status,
            server_ops::commands::get_cached_server_status,
            commands::config::list_scripts,
            commands::config::save_script,
            commands::config::delete_script,
            server_ops::commands::run_script,
            commands::config::get_ai_config,
            commands::config::list_ai_profiles,
            commands::config::save_ai_profile,
            commands::config::delete_ai_profile,
            commands::config::save_ai_approval_mode,
            commands::config::save_ai_agent_mode,
            commands::config::get_agent_context,
            commands::config::save_agent_context,
            commands::config::set_active_ai_profile,
            commands::config::save_ai_config,
            commands::config::list_ai_import_sources,
            commands::config::detect_ai_import_candidates,
            commands::config::import_ai_profiles,
            commands::config::ai_import_source_kind_label,
            commands::ops_agent::ops_agent_list_conversations,
            commands::ops_agent::ops_agent_create_conversation,
            commands::ops_agent::ops_agent_get_conversation,
            commands::ops_agent::ops_agent_get_attachment_content,
            commands::ops_agent::ops_agent_delete_conversation,
            commands::ops_agent::ops_agent_set_active_conversation,
            commands::ops_agent::ops_agent_compact_conversation,
            commands::ops_agent::ops_agent_chat_stream_start,
            commands::ops_agent::ops_agent_list_pending_actions,
            commands::ops_agent::ops_agent_resolve_action,
            commands::ops_agent::ops_agent_cancel_run,
            ops_agent::acp::commands::acp_agent_list,
            ops_agent::acp::commands::acp_agent_start,
            ops_agent::acp::commands::acp_agent_stop,
            ops_agent::acp::commands::acp_session_prompt,
            ops_agent::acp::commands::acp_session_cancel,
            ops_agent::acp::commands::acp_permission_respond,
            ops_agent::acp::commands::acp_session_set_mode,
            ops_agent::acp::commands::acp_session_set_config_option,
            ops_agent::acp::commands::acp_agent_authenticate,
            ops_agent::acp::commands::acp_history_save,
            ops_agent::acp::commands::acp_history_list,
            ops_agent::acp::commands::acp_history_get,
            ops_agent::acp::commands::acp_history_delete,
            commands::ai::ai_ask
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
pub fn run() {}

#[cfg(not(test))]
fn resolve_storage_root() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".eshell-data")
}
