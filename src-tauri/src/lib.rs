pub mod ssh;
pub mod ai;
pub mod monitor;
pub mod config;
pub mod sftp;

use ssh::AppState;
use monitor::MonitorState;
use config::ConfigState;
use sftp::SftpState;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(ConfigState::new(app.handle()));
            Ok(())
        })
        .manage(AppState::new())
        .manage(MonitorState::new())
        .manage(SftpState::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            ssh::connect_ssh,
            ssh::send_command,
            ssh::resize_term,
            ai::ask_ai,
            monitor::get_system_stats,
            monitor::get_top_processes,
            config::load_config,
            config::save_config,
            sftp::list_files,
            sftp::download_file,
            sftp::upload_file,
            sftp::delete_file,
            sftp::create_directory,
            sftp::rename_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
