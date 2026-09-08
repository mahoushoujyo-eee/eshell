use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::models::{AgentContextContent, AgentContextFile, AgentContextList};

use super::Storage;

/// Global AGENTS.md lives directly under the `agent/` data dir; per-server
/// context files are `agent/<serverId>.md`.
const GLOBAL_AGENTS_FILE: &str = "AGENTS.md";

impl Storage {
    /// Reads global (server_id = None) or per-server AGENTS.md content.
    ///
    /// Unlike the old layout, a missing file is reported as `exists: false`
    /// with empty content and is **not** created on read — context files are
    /// created lazily on the first save.
    pub fn get_agent_context(
        &self,
        server_id: Option<&str>,
    ) -> AppResult<AgentContextContent> {
        let server_id = normalize_server_id(server_id);
        let path = self.agent_context_path(server_id.as_deref())?;
        if !path.exists() {
            return Ok(AgentContextContent {
                server_id,
                content: String::new(),
                exists: false,
                path: path.to_string_lossy().to_string(),
            });
        }
        let content = fs::read_to_string(&path)?;
        Ok(AgentContextContent {
            server_id,
            content,
            exists: true,
            path: path.to_string_lossy().to_string(),
        })
    }

    /// Writes global (server_id = None) or per-server AGENTS.md content.
    pub fn save_agent_context(
        &self,
        server_id: Option<&str>,
        content: &str,
    ) -> AppResult<AgentContextContent> {
        let server_id = normalize_server_id(server_id);
        let path = self.agent_context_path(server_id.as_deref())?;
        ensure_parent_dir(&path)?;
        fs::write(&path, content)?;
        Ok(AgentContextContent {
            server_id,
            content: content.to_string(),
            exists: true,
            path: path.to_string_lossy().to_string(),
        })
    }

    /// Deletes a per-server AGENTS.md file. The global file is never deleted.
    pub fn delete_agent_context(
        &self,
        server_id: Option<&str>,
    ) -> AppResult<()> {
        let Some(server_id) = normalize_server_id(server_id) else {
            return Ok(());
        };
        let path = self.agent_context_path(Some(&server_id))?;
        if path.exists() {
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// Enumerates the global context entry plus one entry per stored SSH
    /// server, so the frontend can render the full editor list.
    pub fn list_agent_context_files(&self) -> AppResult<AgentContextList> {
        let global = self.get_agent_context(None)?;
        let server_ids: Vec<String> = self
            .ssh_configs
            .read()
            .expect("ssh config lock poisoned")
            .iter()
            .map(|cfg| cfg.id.clone())
            .collect();

        let mut servers = Vec::with_capacity(server_ids.len());
        for id in server_ids {
            let file = self.get_agent_context(Some(&id))?;
            servers.push(AgentContextFile {
                server_id: Some(id),
                exists: file.exists,
                path: file.path,
            });
        }

        Ok(AgentContextList {
            global: AgentContextFile {
                server_id: None,
                exists: global.exists,
                path: global.path,
            },
            servers,
        })
    }

    /// Returns the global + (optional) per-server context bundle used by the
    /// retained ops-agent backend.
    pub fn load_agent_context_bundle(
        &self,
        server_id: Option<&str>,
    ) -> AppResult<AgentContextBundle> {
        let global = self.get_agent_context(None)?.content;
        let server_id = normalize_server_id(server_id);
        let server = if let Some(server_id) = server_id.as_deref() {
            Some(self.get_agent_context(Some(server_id))?.content)
        } else {
            None
        };
        Ok(AgentContextBundle { global, server })
    }

    fn agent_context_path(&self, server_id: Option<&str>) -> AppResult<PathBuf> {
        let Some(server_id) = normalize_server_id(server_id) else {
            return Ok(self.agent_context_dir.join(GLOBAL_AGENTS_FILE));
        };
        if !is_safe_path_segment(&server_id) {
            return Err(AppError::Validation(
                "serverId contains unsupported path characters".to_string(),
            ));
        }
        Ok(self.agent_context_dir.join(format!("{server_id}.md")))
    }
}

pub struct AgentContextBundle {
    pub global: String,
    pub server: Option<String>,
}

fn normalize_server_id(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_safe_path_segment(value: &str) -> bool {
    !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
        && !value.is_empty()
}

fn ensure_parent_dir(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}
