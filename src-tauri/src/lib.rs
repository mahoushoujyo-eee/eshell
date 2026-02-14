mod ai_service;
mod commands;
mod error;
mod models;
mod ssh_service;
mod state;
mod status_parser;
mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use state::AppState;

/// Application bootstrap entry.
///
/// Runtime behavior:
/// - Creates persistent storage under `.eshell-data` in current working directory.
/// - Registers all Tauri commands used by frontend.
/// - Starts Tauri event loop.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let storage_root = resolve_storage_root();
    let app_state = AppState::new(storage_root).expect("failed to initialize app state");
    let shared_state = Arc::new(app_state);

    tauri::Builder::default()
        .manage(shared_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_ssh_configs,
            commands::save_ssh_config,
            commands::delete_ssh_config,
            commands::list_shell_sessions,
            commands::open_shell_session,
            commands::close_shell_session,
            commands::pty_write_input,
            commands::pty_resize,
            commands::execute_shell_command,
            commands::sftp_list_dir,
            commands::sftp_read_file,
            commands::sftp_write_file,
            commands::sftp_upload_file,
            commands::sftp_download_file,
            commands::fetch_server_status,
            commands::get_cached_server_status,
            commands::list_scripts,
            commands::save_script,
            commands::delete_script,
            commands::run_script,
            commands::get_ai_config,
            commands::list_ai_profiles,
            commands::save_ai_profile,
            commands::delete_ai_profile,
            commands::set_active_ai_profile,
            commands::save_ai_config,
            commands::ai_ask
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn resolve_storage_root() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".eshell-data")
}
