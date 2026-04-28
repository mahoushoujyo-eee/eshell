use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{now_rfc3339, SshConfig, SshConfigInput};

use super::io::write_json_pretty;
use super::Storage;

impl Storage {
    /// Returns SSH connection configurations sorted by creation order.
    pub fn list_ssh_configs(&self) -> Vec<SshConfig> {
        self.ssh_configs
            .read()
            .expect("ssh config lock poisoned")
            .clone()
    }

    /// Creates or updates an SSH configuration and persists the updated collection.
    pub fn upsert_ssh_config(&self, input: SshConfigInput) -> AppResult<SshConfig> {
        if input.name.trim().is_empty() {
            return Err(AppError::Validation("name cannot be empty".to_string()));
        }
        if input.host.trim().is_empty() {
            return Err(AppError::Validation("host cannot be empty".to_string()));
        }
        if input.username.trim().is_empty() {
            return Err(AppError::Validation("username cannot be empty".to_string()));
        }
        if input.port == 0 {
            return Err(AppError::Validation("port must be in 1-65535".to_string()));
        }

        let now = now_rfc3339();
        let mut guard = self.ssh_configs.write().expect("ssh config lock poisoned");

        let config = match input.id.as_deref() {
            Some(id) => {
                let index = guard
                    .iter()
                    .position(|item| item.id == id)
                    .ok_or_else(|| AppError::NotFound(format!("ssh config {id}")))?;
                let existing = &guard[index];
                let updated = SshConfig {
                    id: existing.id.clone(),
                    name: input.name.trim().to_string(),
                    host: input.host.trim().to_string(),
                    port: input.port,
                    username: input.username.trim().to_string(),
                    password: input.password,
                    description: input.description.unwrap_or_default().trim().to_string(),
                    created_at: existing.created_at.clone(),
                    updated_at: now,
                };
                guard[index] = updated.clone();
                updated
            }
            None => {
                let created = SshConfig {
                    id: Uuid::new_v4().to_string(),
                    name: input.name.trim().to_string(),
                    host: input.host.trim().to_string(),
                    port: input.port,
                    username: input.username.trim().to_string(),
                    password: input.password,
                    description: input.description.unwrap_or_default().trim().to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                guard.push(created.clone());
                created
            }
        };

        write_json_pretty(&self.ssh_configs_path, &*guard)?;
        self.get_agent_context(Some(&config.id))?;
        Ok(config)
    }

    /// Removes an SSH configuration by id and persists the collection.
    pub fn delete_ssh_config(&self, id: &str) -> AppResult<()> {
        let mut guard = self.ssh_configs.write().expect("ssh config lock poisoned");
        let before = guard.len();
        guard.retain(|config| config.id != id);
        if guard.len() == before {
            return Err(AppError::NotFound(format!("ssh config {id}")));
        }
        write_json_pretty(&self.ssh_configs_path, &*guard)?;
        Ok(())
    }

    /// Reads a single SSH configuration by id.
    pub fn find_ssh_config(&self, id: &str) -> AppResult<SshConfig> {
        self.ssh_configs
            .read()
            .expect("ssh config lock poisoned")
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("ssh config {id}")))
    }
}
