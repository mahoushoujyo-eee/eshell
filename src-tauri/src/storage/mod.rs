mod ai_profiles;
mod io;
mod scripts;
mod ssh;

use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use crate::error::AppResult;
use crate::models::{AiConfig, AiProfilesState, ScriptDefinition, SshConfig};

use ai_profiles::{ensure_ai_profiles_state, load_ai_profiles_state};
use io::{read_json_or_default, write_json_pretty};

const SSH_CONFIGS_FILE: &str = "ssh_configs.json";
const SCRIPTS_FILE: &str = "scripts.json";
const AI_PROFILES_FILE: &str = "ai_profiles.json";
const LEGACY_AI_CONFIG_FILE: &str = "ai_config.json";

/// Handles JSON-backed persistence for user-managed configurations.
///
/// AI configuration is persisted in a single source of truth: `ai_profiles.json`.
/// The legacy `ai_config.json` is read once for migration when profiles are missing.
pub struct Storage {
    ssh_configs_path: PathBuf,
    scripts_path: PathBuf,
    ai_profiles_path: PathBuf,
    ssh_configs: RwLock<Vec<SshConfig>>,
    scripts: RwLock<Vec<ScriptDefinition>>,
    ai_profiles: RwLock<AiProfilesState>,
}

impl Storage {
    /// Initializes storage from disk and creates missing files/directories with defaults.
    pub fn new(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&root)?;

        let ssh_configs_path = root.join(SSH_CONFIGS_FILE);
        let scripts_path = root.join(SCRIPTS_FILE);
        let ai_profiles_path = root.join(AI_PROFILES_FILE);
        let legacy_ai_config_path = root.join(LEGACY_AI_CONFIG_FILE);

        let ssh_configs = read_json_or_default::<Vec<SshConfig>>(&ssh_configs_path)?;
        let scripts = read_json_or_default::<Vec<ScriptDefinition>>(&scripts_path)?;
        let mut ai_profiles = load_ai_profiles_state(&ai_profiles_path)?;

        // Migration fallback for older versions that only stored one ai_config.json.
        let legacy_ai_config = read_json_or_default::<AiConfig>(&legacy_ai_config_path)?;
        ensure_ai_profiles_state(&mut ai_profiles, &legacy_ai_config);

        // Ensure files always exist after bootstrap for easier debugging and manual inspection.
        write_json_pretty(&ssh_configs_path, &ssh_configs)?;
        write_json_pretty(&scripts_path, &scripts)?;
        write_json_pretty(&ai_profiles_path, &ai_profiles)?;

        // Remove legacy file after successful migration to avoid dual-source confusion.
        if legacy_ai_config_path.exists() {
            let _ = fs::remove_file(&legacy_ai_config_path);
        }

        Ok(Self {
            ssh_configs_path,
            scripts_path,
            ai_profiles_path,
            ssh_configs: RwLock::new(ssh_configs),
            scripts: RwLock::new(scripts),
            ai_profiles: RwLock::new(ai_profiles),
        })
    }

    /// Returns the persistent data directory (typically `.eshell-data`).
    pub fn data_dir(&self) -> PathBuf {
        self.ai_profiles_path
            .parent()
            .map(|item| item.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

#[cfg(test)]
mod tests;
