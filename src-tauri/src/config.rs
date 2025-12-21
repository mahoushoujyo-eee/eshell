use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    pub sessions: Vec<crate::ssh::SshConfig>,
}

pub struct ConfigState {
    pub config_path: PathBuf,
}

impl ConfigState {
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        let config_dir = app.path().app_config_dir().expect("failed to get app config dir");
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir).expect("failed to create config dir");
        }
        Self {
            config_path: config_dir.join("config.json"),
        }
    }
}

#[tauri::command]
pub fn load_config(state: tauri::State<'_, ConfigState>) -> Result<AppConfig, String> {
    if !state.config_path.exists() {
        return Ok(AppConfig::default());
    }
    
    let content = fs::read_to_string(&state.config_path).map_err(|e| e.to_string())?;
    let config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub fn save_config(state: tauri::State<'_, ConfigState>, config: AppConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&state.config_path, content).map_err(|e| e.to_string())?;
    Ok(())
}
