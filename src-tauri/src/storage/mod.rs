pub(crate) mod ai_import;
mod ai_profiles;
mod agent_context;
mod io;
mod known_hosts;
mod reload;
mod scripts;
mod ssh;

pub use reload::{ConfigFile, ReloadOutcome};

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::error::AppResult;
use crate::models::{AiConfig, AiProfilesState, ScriptDefinition, SshConfig, SshKnownHost};

use ai_profiles::{ensure_ai_profiles_state, load_ai_profiles_state};
use io::{read_json_or_default, write_json_pretty};

const SSH_CONFIGS_FILE: &str = "ssh_configs.json";
const KNOWN_HOSTS_FILE: &str = "known_hosts.json";
const SCRIPTS_FILE: &str = "scripts.json";
const AI_PROFILES_FILE: &str = "ai_profiles.json";
const LEGACY_AI_CONFIG_FILE: &str = "ai_config.json";
/// Root of the agent context file mapping under `.eshell-data/`.
const AGENT_CONTEXT_DIR: &str = "agent";
/// Global agent context file, stored at `agent/AGENTS.md`.
const GLOBAL_AGENTS_FILE: &str = "AGENTS.md";

/// Handles JSON-backed persistence for user-managed configurations.
///
/// AI configuration is persisted in a single source of truth: `ai_profiles.json`.
/// The legacy `ai_config.json` is read once for migration when profiles are missing.
pub struct Storage {
    ssh_configs_path: PathBuf,
    known_hosts_path: PathBuf,
    scripts_path: PathBuf,
    ai_profiles_path: PathBuf,
    agent_context_dir: PathBuf,
    ssh_configs: RwLock<Vec<SshConfig>>,
    known_hosts: RwLock<Vec<SshKnownHost>>,
    scripts: RwLock<Vec<ScriptDefinition>>,
    ai_profiles: RwLock<AiProfilesState>,
}

impl Storage {
    /// Initializes storage from disk and creates missing files/directories with defaults.
    pub fn new(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&root)?;

        let ssh_configs_path = root.join(SSH_CONFIGS_FILE);
        let known_hosts_path = root.join(KNOWN_HOSTS_FILE);
        let scripts_path = root.join(SCRIPTS_FILE);
        let ai_profiles_path = root.join(AI_PROFILES_FILE);
        let agent_context_dir = root.join(AGENT_CONTEXT_DIR);
        let legacy_ai_config_path = root.join(LEGACY_AI_CONFIG_FILE);
        fs::create_dir_all(&agent_context_dir)?;

        let ssh_configs = read_json_or_default::<Vec<SshConfig>>(&ssh_configs_path)?;
        let known_hosts = read_json_or_default::<Vec<SshKnownHost>>(&known_hosts_path)?;
        let scripts = read_json_or_default::<Vec<ScriptDefinition>>(&scripts_path)?;
        let mut ai_profiles = load_ai_profiles_state(&ai_profiles_path)?;

        // Migration fallback for older versions that only stored one ai_config.json.
        let legacy_ai_config = read_json_or_default::<AiConfig>(&legacy_ai_config_path)?;
        ensure_ai_profiles_state(&mut ai_profiles, &legacy_ai_config);

        // Ensure files always exist after bootstrap for easier debugging and manual inspection.
        write_json_pretty(&ssh_configs_path, &ssh_configs)?;
        write_json_pretty(&known_hosts_path, &known_hosts)?;
        write_json_pretty(&scripts_path, &scripts)?;
        write_json_pretty(&ai_profiles_path, &ai_profiles)?;

        // Agent context: seed a default global file, migrate any legacy layout,
        // and bundle the eshell-config skill into `.eshell-data/agent/skills/`.
        seed_agent_context(&root, &agent_context_dir)?;

        // Remove legacy file after successful migration to avoid dual-source confusion.
        if legacy_ai_config_path.exists() {
            let _ = fs::remove_file(&legacy_ai_config_path);
        }

        Ok(Self {
            ssh_configs_path,
            known_hosts_path,
            scripts_path,
            ai_profiles_path,
            agent_context_dir,
            ssh_configs: RwLock::new(ssh_configs),
            known_hosts: RwLock::new(known_hosts),
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

    /// Lists every AI import source the user can pick from.
    pub fn list_ai_import_sources(&self, custom_paths: &[String]) -> Vec<crate::models::AiImportSource> {
        ai_import::list_ai_import_sources(custom_paths)
    }

    /// Detects importable AI profiles from a previously discovered source.
    pub fn detect_ai_import_candidates(
        &self,
        source: &crate::models::AiImportSource,
    ) -> crate::error::AppResult<(Vec<crate::models::AiImportCandidate>, Vec<String>)> {
        ai_import::detect_ai_import_candidates(source)
    }

    /// Persists the supplied import candidates as new AI profiles.
    pub fn import_ai_profiles(
        &self,
        candidates: Vec<crate::models::AiImportCandidate>,
    ) -> crate::error::AppResult<crate::models::ImportAiProfilesResult> {
        let mut guard = self
            .ai_profiles
            .write()
            .expect("ai profiles lock poisoned");
        ensure_ai_profiles_state(&mut guard, &AiConfig::default());
        let (imported, skipped) = ai_import::merge_imported_profiles(&mut guard, candidates)?;
        write_json_pretty(&self.ai_profiles_path, &*guard)?;
        Ok(crate::models::ImportAiProfilesResult {
            state: guard.clone(),
            imported,
            skipped,
        })
    }
}

/// Seeds the agent context area under `.eshell-data/agent/`: a default global
/// AGENTS.md, migrated legacy files, and the bundled skills.
fn seed_agent_context(root: &Path, agent_dir: &Path) -> AppResult<()> {
    let global_path = agent_dir.join(GLOBAL_AGENTS_FILE);
    if !global_path.exists() {
        fs::write(&global_path, "")?;
    }

    // One-time migration from the old `.eshell-data/AGENTS.md` +
    // `server_agents/<id>/AGENTS.md` layout, copied only when the new target
    // file does not already exist (so a user edit is never overwritten).
    migrate_legacy_agent_context(root, agent_dir)?;

    seed_eshell_config_skill(agent_dir)?;
    seed_eshell_plugin_dev_skill(agent_dir)
}

fn migrate_legacy_agent_context(root: &Path, agent_dir: &Path) -> AppResult<()> {
    let old_global = root.join(GLOBAL_AGENTS_FILE);
    let new_global = agent_dir.join(GLOBAL_AGENTS_FILE);
    if old_global.exists() && !new_global.exists() {
        let content = fs::read_to_string(&old_global)?;
        fs::write(&new_global, content)?;
    }

    let old_servers = root.join("server_agents");
    if !old_servers.is_dir() {
        return Ok(());
    }
    if let Ok(entries) = fs::read_dir(&old_servers) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(id) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !is_safe_segment(id) {
                continue;
            }
            let old_file = dir.join(GLOBAL_AGENTS_FILE);
            let new_file = agent_dir.join(format!("{id}.md"));
            if old_file.exists() && !new_file.exists() {
                let content = fs::read_to_string(&old_file)?;
                fs::write(&new_file, content)?;
            }
        }
    }
    Ok(())
}

/// Seeds the bundled `eshell-config` skill into `.eshell-data/agent/skills/`.
/// Files are written only when missing, preserving any user/agent edits.
fn seed_eshell_config_skill(agent_dir: &Path) -> AppResult<()> {
    let skill_dir = agent_dir.join("skills").join("eshell-config");
    let skill_md = skill_dir.join("SKILL.md");
    let doc_md = skill_dir.join("docs").join("acp_agent.md");

    if !skill_md.exists() {
        fs::create_dir_all(&skill_dir)?;
        fs::write(
            &skill_md,
            include_str!("../../../skills/eshell-config/SKILL.md"),
        )?;
    }
    if !doc_md.exists() {
        if let Some(parent) = doc_md.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            &doc_md,
            include_str!("../../../skills/eshell-config/docs/acp_agent.md"),
        )?;
    }
    Ok(())
}

/// Seeds the bundled `eshell-plugin-dev` skill into
/// `.eshell-data/agent/skills/`. Same rule as the config skill: written only
/// when missing, so a user or agent edit survives every later launch.
fn seed_eshell_plugin_dev_skill(agent_dir: &Path) -> AppResult<()> {
    let skill_dir = agent_dir.join("skills").join("eshell-plugin-dev");
    let skill_md = skill_dir.join("SKILL.md");

    if !skill_md.exists() {
        fs::create_dir_all(&skill_dir)?;
        fs::write(
            &skill_md,
            include_str!("../../../skills/eshell-plugin-dev/SKILL.md"),
        )?;
    }
    Ok(())
}

fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

#[cfg(test)]
mod tests;
