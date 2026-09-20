//! Re-reading config files that were edited outside the app.
//!
//! Config lives in JSON files under `.eshell-data/`, and users (and agents)
//! edit them directly. Until now every one of those edits needed a restart,
//! because the values were read once at startup. This module re-reads them on
//! demand and swaps the in-memory copies.
//!
//! Scope and rules:
//!
//! - **Only files that are read into memory are reloadable.** `ssh_configs.json`,
//!   `acp_agents.json`, `scripts.json`, `ai_profiles.json`, and the agent
//!   context markdown are. `known_hosts.json` is deliberately excluded: it is
//!   a trust store written by the host-key prompt, and re-reading it from disk
//!   would let a hand-edited file silently widen trust mid-session.
//! - **A reload never invents state.** A file that is missing or empty leaves
//!   the current value alone rather than clearing it: a half-written file must
//!   not wipe the user's servers.
//! - **A parse failure is reported, not applied.** The in-memory copy stays on
//!   the last good value, and the error names the file so the caller can fix it.
//! - **Reloading does not restart anything.** Open SSH sessions keep their
//!   existing connection; a new config takes effect for the next connection.
//!   A running ACP agent keeps its spawn settings until it is restarted.
//!
//! Each reload is one unit so a caller can reload everything or just the file
//! it changed.

use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::io::read_json_or_default;
use super::Storage;

/// One reloadable config file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigFile {
    /// `ssh_configs.json` — SSH connection profiles.
    SshConfigs,
    /// `acp_agents.json` — ACP agent spawn settings.
    AcpAgents,
    /// `scripts.json` — the saved script center.
    Scripts,
    /// `ai_profiles.json` — AI provider profiles and the active selection.
    AiProfiles,
    /// `agent/AGENTS.md` and `agent/<serverId>.md` — agent context.
    AgentContext,
}

impl ConfigFile {
    /// Every reloadable file, in a stable order.
    pub const ALL: [ConfigFile; 5] = [
        ConfigFile::SshConfigs,
        ConfigFile::AcpAgents,
        ConfigFile::Scripts,
        ConfigFile::AiProfiles,
        ConfigFile::AgentContext,
    ];

    /// Parses a wire name (`"sshConfigs"`, `"acpAgents"`, …).
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim() {
            "sshConfigs" => Ok(ConfigFile::SshConfigs),
            "acpAgents" => Ok(ConfigFile::AcpAgents),
            "scripts" => Ok(ConfigFile::Scripts),
            "aiProfiles" => Ok(ConfigFile::AiProfiles),
            "agentContext" => Ok(ConfigFile::AgentContext),
            other => Err(AppError::Validation(format!(
                "unknown config file {other:?}; expected one of \
                 sshConfigs, acpAgents, scripts, aiProfiles, agentContext"
            ))),
        }
    }

    /// The file this variant reads, relative to the storage root.
    pub fn file_name(self) -> &'static str {
        match self {
            ConfigFile::SshConfigs => "ssh_configs.json",
            ConfigFile::AcpAgents => "acp_agents.json",
            ConfigFile::Scripts => "scripts.json",
            ConfigFile::AiProfiles => "ai_profiles.json",
            ConfigFile::AgentContext => "agent/AGENTS.md",
        }
    }
}

/// What one file's reload did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadOutcome {
    /// The wire name of the file, for the caller to match on.
    pub file: String,
    /// The path that was read, so the caller can show it.
    pub path: String,
    /// `true` when the in-memory value changed.
    pub changed: bool,
    /// `true` when the file did not exist; the current value was kept.
    pub missing: bool,
    /// Set when the file exists but could not be applied. The current value
    /// is unchanged, and this explains why.
    pub error: Option<String>,
}

impl ReloadOutcome {
    fn applied(file: ConfigFile, path: String, changed: bool) -> Self {
        Self {
            file: wire_name(file).to_string(),
            path,
            changed,
            missing: false,
            error: None,
        }
    }

    fn missing(file: ConfigFile, path: String) -> Self {
        Self {
            file: wire_name(file).to_string(),
            path,
            changed: false,
            missing: true,
            error: None,
        }
    }

    fn failed(file: ConfigFile, path: String, error: String) -> Self {
        Self {
            file: wire_name(file).to_string(),
            path,
            changed: false,
            missing: false,
            error: Some(error),
        }
    }
}

fn wire_name(file: ConfigFile) -> &'static str {
    match file {
        ConfigFile::SshConfigs => "sshConfigs",
        ConfigFile::AcpAgents => "acpAgents",
        ConfigFile::Scripts => "scripts",
        ConfigFile::AiProfiles => "aiProfiles",
        ConfigFile::AgentContext => "agentContext",
    }
}

impl Storage {
    /// Re-reads one config file and swaps the in-memory copy.
    ///
    /// Never returns `Err` for a bad file: a parse failure is reported in the
    /// outcome so one broken file does not abort a multi-file reload. The
    /// `Err` case is reserved for a caller asking for an unknown file.
    pub fn reload_config(&self, file: ConfigFile) -> ReloadOutcome {
        let path = self.config_path(file);
        let display = path.to_string_lossy().to_string();

        if !path.exists() {
            return ReloadOutcome::missing(file, display);
        }

        match file {
            ConfigFile::SshConfigs => match read_json_or_default::<Vec<crate::models::SshConfig>>(&path)
            {
                Ok(next) => {
                    let mut guard = self.ssh_configs.write().expect("ssh config lock poisoned");
                    let changed = *guard != next;
                    *guard = next;
                    ReloadOutcome::applied(file, display, changed)
                }
                Err(error) => ReloadOutcome::failed(file, display, error.to_string()),
            },
            ConfigFile::Scripts => {
                match read_json_or_default::<Vec<crate::models::ScriptDefinition>>(&path) {
                    Ok(next) => {
                        let mut guard = self.scripts.write().expect("script lock poisoned");
                        let changed = *guard != next;
                        *guard = next;
                        ReloadOutcome::applied(file, display, changed)
                    }
                    Err(error) => ReloadOutcome::failed(file, display, error.to_string()),
                }
            }
            ConfigFile::AiProfiles => match super::ai_profiles::load_ai_profiles_state(&path) {
                Ok(next) => {
                    let mut guard = self.ai_profiles.write().expect("ai profile lock poisoned");
                    let changed = *guard != next;
                    *guard = next;
                    ReloadOutcome::applied(file, display, changed)
                }
                Err(error) => ReloadOutcome::failed(file, display, error.to_string()),
            },
            // ACP agent configs and agent context are not cached in `Storage`:
            // they are read from disk at each use, so there is nothing to swap.
            // Reporting them here keeps one uniform surface for callers, and
            // the read is still a real check that the file parses.
            ConfigFile::AcpAgents => {
                match crate::ops_agent::acp::commands::load_agent_configs(&self.data_dir()) {
                    Ok(_) => ReloadOutcome::applied(file, display, false),
                    Err(error) => ReloadOutcome::failed(file, display, error.to_string()),
                }
            }
            ConfigFile::AgentContext => match std::fs::read_to_string(&path) {
                Ok(_) => ReloadOutcome::applied(file, display, false),
                Err(error) => ReloadOutcome::failed(file, display, error.to_string()),
            },
        }
    }

    /// Re-reads every reloadable file. One failure does not stop the others.
    pub fn reload_all_configs(&self) -> Vec<ReloadOutcome> {
        ConfigFile::ALL
            .iter()
            .map(|file| self.reload_config(*file))
            .collect()
    }

    /// The on-disk path of one reloadable file.
    pub fn config_path(&self, file: ConfigFile) -> std::path::PathBuf {
        match file {
            ConfigFile::SshConfigs => self.ssh_configs_path.clone(),
            ConfigFile::Scripts => self.scripts_path.clone(),
            ConfigFile::AiProfiles => self.ai_profiles_path.clone(),
            ConfigFile::AcpAgents => self.data_dir().join("acp_agents.json"),
            ConfigFile::AgentContext => self.agent_context_dir.join("AGENTS.md"),
        }
    }
}
