use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::models::AgentContextContent;

use super::Storage;

const AGENTS_FILE: &str = "AGENTS.md";

impl Storage {
    pub fn get_agent_context(
        &self,
        server_id: Option<&str>,
    ) -> AppResult<AgentContextContent> {
        let server_id = normalize_server_id(server_id);
        let path = self.agent_context_path(server_id.as_deref())?;
        ensure_parent_dir(&path)?;
        if !path.exists() {
            fs::write(&path, "")?;
        }
        let content = fs::read_to_string(&path)?;
        Ok(AgentContextContent {
            server_id,
            content,
            path: path.to_string_lossy().to_string(),
        })
    }

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
            path: path.to_string_lossy().to_string(),
        })
    }

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
            return Ok(self.global_agents_path.clone());
        };
        if !is_safe_path_segment(&server_id) {
            return Err(AppError::Validation(
                "serverId contains unsupported path characters".to_string(),
            ));
        }
        Ok(self.server_agents_dir.join(server_id).join(AGENTS_FILE))
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
