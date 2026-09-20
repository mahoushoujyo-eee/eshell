use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::common::error::AppResult;
use crate::domain::scripts::model::ScriptDefinition;
use crate::domain::ssh::model::{SshConfig, SshKnownHost};

use crate::domain::config::consts::*;
use crate::domain::config::service::io::{read_json_or_default, write_json_pretty};

/// Handles JSON-backed persistence for user-managed configurations.
///
pub struct Storage {
    pub(crate) ssh_configs_path: PathBuf,
    pub(crate) known_hosts_path: PathBuf,
    pub(crate) scripts_path: PathBuf,
    pub(crate) agent_context_dir: PathBuf,
    pub(crate) ssh_configs: RwLock<Vec<SshConfig>>,
    pub(crate) known_hosts: RwLock<Vec<SshKnownHost>>,
    pub(crate) scripts: RwLock<Vec<ScriptDefinition>>,
}

impl Storage {
    /// Initializes storage from disk and creates missing files/directories with defaults.
    pub fn new(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&root)?;

        let ssh_configs_path = root.join(SSH_CONFIGS_FILE);
        let known_hosts_path = root.join(KNOWN_HOSTS_FILE);
        let scripts_path = root.join(SCRIPTS_FILE);
        let agent_context_dir = root.join(AGENT_CONTEXT_DIR);
        fs::create_dir_all(&agent_context_dir)?;

        let ssh_configs = read_json_or_default::<Vec<SshConfig>>(&ssh_configs_path)?;
        let known_hosts = read_json_or_default::<Vec<SshKnownHost>>(&known_hosts_path)?;
        let scripts = read_json_or_default::<Vec<ScriptDefinition>>(&scripts_path)?;

        // Ensure files always exist after bootstrap for easier debugging and manual inspection.
        write_json_pretty(&ssh_configs_path, &ssh_configs)?;
        write_json_pretty(&known_hosts_path, &known_hosts)?;
        write_json_pretty(&scripts_path, &scripts)?;

        // Agent context: seed a default global file, migrate any legacy layout,
        // and bundle the eshell-config skill into `.eshell-data/agent/skills/`.
        seed_agent_context(&root, &agent_context_dir)?;

        // Remove the legacy single-config file after migration to avoid
        // dual-source confusion (the profiles store replaced it).
        let legacy = root.join("ai_config.json");
        if legacy.exists() {
            let _ = fs::remove_file(&legacy);
        }

        Ok(Self {
            ssh_configs_path,
            known_hosts_path,
            scripts_path,
            agent_context_dir,
            ssh_configs: RwLock::new(ssh_configs),
            known_hosts: RwLock::new(known_hosts),
            scripts: RwLock::new(scripts),
        })
    }

    /// Returns the persistent data directory (typically `.eshell-data`).
    pub fn data_dir(&self) -> PathBuf {
        self.scripts_path
            .parent()
            .map(|item| item.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
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
            include_str!("../../../../../skills/eshell-config/SKILL.md"),
        )?;
    }
    if !doc_md.exists() {
        if let Some(parent) = doc_md.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            &doc_md,
            include_str!("../../../../../skills/eshell-config/docs/acp_agent.md"),
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
            include_str!("../../../../../skills/eshell-plugin-dev/SKILL.md"),
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

