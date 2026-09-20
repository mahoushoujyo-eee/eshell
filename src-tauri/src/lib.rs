mod common;
mod domain;
mod state;

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

    let builder = tauri::Builder::default()
        .manage(shared_state)
        // External plugin bundles: http://plugin.localhost/<id>/<main> on
        // Windows, plugin://localhost/<id>/<main> elsewhere. See
        // `domain::extensions::service::protocol` for the containment rules.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |_app| {
            // Local MCP bridge: exposes eShell's sessions/SFTP as tools that
            // get injected into ACP agent sessions. Failure is non-fatal —
            // agents simply start without the eshell toolset.
            tauri::async_runtime::spawn(async move {
                if let Err(error) = domain::agent::service::mcp_bridge::start(bridge_state).await {
                    eprintln!("mcp bridge failed to start: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            domain::app_update::command::app_version,
            domain::app_update::command::check_app_update,
            domain::config::command::list_ssh_configs,
            domain::config::command::save_ssh_config,
            domain::config::command::delete_ssh_config,
            domain::config::command::trust_ssh_host_key,
            domain::config::command::reload_config,
            domain::config::command::list_reloadable_configs,
            domain::ssh::command::list_shell_sessions,
            domain::ssh::command::open_shell_session,
            domain::ssh::command::cancel_open_shell_session,
            domain::ssh::command::reopen_shell_pty,
            domain::ssh::command::close_shell_session,
            domain::ssh::command::pty_write_input,
            domain::ssh::command::pty_resize,
            domain::ssh::command::execute_shell_command,
            domain::sftp::service::sftp_list_dir,
            domain::sftp::service::sftp_read_file,
            domain::sftp::service::sftp_write_file,
            domain::sftp::service::sftp_create_file,
            domain::sftp::service::sftp_create_directory,
            domain::sftp::service::sftp_upload_file,
            domain::sftp::service::sftp_delete_entry,
            domain::sftp::service::sftp_rename_entry,
            domain::sftp::service::sftp_upload_file_with_progress,
            domain::sftp::service::sftp_upload_local_file_with_progress,
            domain::sftp::service::sftp_download_file,
            domain::sftp::service::sftp_download_file_to_local,
            domain::sftp::service::sftp_default_download_dir,
            domain::sftp::service::sftp_cancel_transfer,
            domain::ssh::command::ssh_ki_respond,
            domain::monitor::service::fetch_server_status,
            domain::monitor::service::get_cached_server_status,
            domain::extensions::command::list_extensions,
            domain::extensions::command::set_extension_enabled,
            domain::extensions::command::list_external_plugins,
            domain::extensions::command::install_extension,
            domain::extensions::command::uninstall_extension,
            domain::extensions::service::broker::invoke_extension_api,
            domain::scripts::command::list_scripts,
            domain::scripts::command::save_script,
            domain::scripts::command::delete_script,
            domain::scripts::command::run_script,
            domain::config::command::get_agent_context,
            domain::config::command::save_agent_context,
            domain::config::command::list_agent_context_files,
            domain::config::command::delete_agent_context,
            domain::agent::command::acp_agent_list,
            domain::agent::command::acp_agent_start,
            domain::agent::command::acp_agent_stop,
            domain::agent::command::acp_session_prompt,
            domain::agent::command::acp_session_cancel,
            domain::agent::command::acp_session_new,
            domain::agent::command::acp_permission_respond,
            domain::agent::command::acp_session_set_mode,
            domain::agent::command::acp_session_set_config_option,
            domain::agent::command::acp_agent_authenticate,
            domain::agent::command::acp_history_save,
            domain::agent::command::acp_history_list,
            domain::agent::command::acp_history_get,
            domain::agent::command::acp_history_delete,
            domain::agent::service::projects::acp_project_list,
            domain::agent::service::projects::acp_project_create,
            domain::agent::service::projects::acp_project_delete,
        ]);
    attach_plugin_scheme(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Registers the external-plugin URI scheme on the production builder.
///
/// Kept as a free function so the protocol module stays runtime-agnostic and
/// unit-testable; the Builder API is consumed here, in the real application
/// bootstrap.
#[cfg(not(test))]
fn attach_plugin_scheme(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    domain::extensions::service::protocol::register_plugin_scheme(builder)
}

#[cfg(test)]
pub fn run() {}

#[cfg(not(test))]
fn resolve_storage_root() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".eshell-data")
}
