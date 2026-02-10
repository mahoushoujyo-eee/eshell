use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    now_rfc3339, AiConfig, AiConfigInput, ScriptDefinition, ScriptInput, SshConfig, SshConfigInput,
};

/// Handles JSON-backed persistence for user-managed configurations.
pub struct Storage {
    ssh_configs_path: PathBuf,
    scripts_path: PathBuf,
    ai_config_path: PathBuf,
    ssh_configs: RwLock<Vec<SshConfig>>,
    scripts: RwLock<Vec<ScriptDefinition>>,
    ai_config: RwLock<AiConfig>,
}

impl Storage {
    /// Initializes storage from disk and creates missing files/directories with defaults.
    pub fn new(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&root)?;

        let ssh_configs_path = root.join("ssh_configs.json");
        let scripts_path = root.join("scripts.json");
        let ai_config_path = root.join("ai_config.json");

        let ssh_configs = read_json_or_default::<Vec<SshConfig>>(&ssh_configs_path)?;
        let scripts = read_json_or_default::<Vec<ScriptDefinition>>(&scripts_path)?;
        let ai_config = read_json_or_default::<AiConfig>(&ai_config_path)?;

        // Ensure files always exist after bootstrap for easier debugging and manual inspection.
        write_json_pretty(&ssh_configs_path, &ssh_configs)?;
        write_json_pretty(&scripts_path, &scripts)?;
        write_json_pretty(&ai_config_path, &ai_config)?;

        Ok(Self {
            ssh_configs_path,
            scripts_path,
            ai_config_path,
            ssh_configs: RwLock::new(ssh_configs),
            scripts: RwLock::new(scripts),
            ai_config: RwLock::new(ai_config),
        })
    }

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

    /// Returns script definitions in persistent order.
    pub fn list_scripts(&self) -> Vec<ScriptDefinition> {
        self.scripts.read().expect("script lock poisoned").clone()
    }

    /// Creates or updates a script definition and persists the collection.
    pub fn upsert_script(&self, input: ScriptInput) -> AppResult<ScriptDefinition> {
        if input.name.trim().is_empty() {
            return Err(AppError::Validation("script name cannot be empty".to_string()));
        }

        let path = input.path.unwrap_or_default().trim().to_string();
        let command = input.command.unwrap_or_default().trim().to_string();
        if path.is_empty() && command.is_empty() {
            return Err(AppError::Validation(
                "script path and command cannot both be empty".to_string(),
            ));
        }

        let mut guard = self.scripts.write().expect("script lock poisoned");
        let now = now_rfc3339();

        let script = match input.id.as_deref() {
            Some(id) => {
                let index = guard
                    .iter()
                    .position(|item| item.id == id)
                    .ok_or_else(|| AppError::NotFound(format!("script {id}")))?;
                let existing = &guard[index];
                let updated = ScriptDefinition {
                    id: existing.id.clone(),
                    name: input.name.trim().to_string(),
                    path,
                    command,
                    description: input.description.unwrap_or_default().trim().to_string(),
                    created_at: existing.created_at.clone(),
                    updated_at: now,
                };
                guard[index] = updated.clone();
                updated
            }
            None => {
                let created = ScriptDefinition {
                    id: Uuid::new_v4().to_string(),
                    name: input.name.trim().to_string(),
                    path,
                    command,
                    description: input.description.unwrap_or_default().trim().to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                guard.push(created.clone());
                created
            }
        };

        write_json_pretty(&self.scripts_path, &*guard)?;
        Ok(script)
    }

    /// Deletes a script definition by id and persists changes.
    pub fn delete_script(&self, id: &str) -> AppResult<()> {
        let mut guard = self.scripts.write().expect("script lock poisoned");
        let before = guard.len();
        guard.retain(|script| script.id != id);
        if guard.len() == before {
            return Err(AppError::NotFound(format!("script {id}")));
        }
        write_json_pretty(&self.scripts_path, &*guard)?;
        Ok(())
    }

    /// Returns a script by id.
    pub fn find_script(&self, id: &str) -> AppResult<ScriptDefinition> {
        self.scripts
            .read()
            .expect("script lock poisoned")
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("script {id}")))
    }

    /// Returns the persisted AI provider configuration.
    pub fn get_ai_config(&self) -> AiConfig {
        self.ai_config.read().expect("ai lock poisoned").clone()
    }

    /// Validates and persists AI provider configuration.
    pub fn save_ai_config(&self, input: AiConfigInput) -> AppResult<AiConfig> {
        if input.base_url.trim().is_empty() {
            return Err(AppError::Validation("baseUrl cannot be empty".to_string()));
        }
        if input.model.trim().is_empty() {
            return Err(AppError::Validation("model cannot be empty".to_string()));
        }
        if !(0.0..=2.0).contains(&input.temperature) {
            return Err(AppError::Validation(
                "temperature must be between 0 and 2".to_string(),
            ));
        }

        let config = AiConfig {
            base_url: input.base_url.trim().trim_end_matches('/').to_string(),
            api_key: input.api_key.trim().to_string(),
            model: input.model.trim().to_string(),
            system_prompt: input.system_prompt.trim().to_string(),
            temperature: input.temperature,
            max_tokens: input.max_tokens,
            updated_at: now_rfc3339(),
        };

        *self.ai_config.write().expect("ai lock poisoned") = config.clone();
        write_json_pretty(&self.ai_config_path, &config)?;
        Ok(config)
    }
}

fn read_json_or_default<T>(path: &Path) -> AppResult<T>
where
    T: serde::de::DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let content = fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(T::default());
    }
    Ok(serde_json::from_str(&content)?)
}

fn write_json_pretty<T>(path: &Path, value: &T) -> AppResult<()>
where
    T: serde::Serialize,
{
    let text = serde_json::to_string_pretty(value)?;
    fs::write(path, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        env::temp_dir().join(format!("eshell-{name}-{stamp}"))
    }

    #[test]
    fn ssh_config_crud_works() {
        let storage = Storage::new(temp_dir("ssh")).expect("create storage");
        let created = storage
            .upsert_ssh_config(SshConfigInput {
                id: None,
                name: "prod".to_string(),
                host: "10.0.0.8".to_string(),
                port: 22,
                username: "root".to_string(),
                password: "secret".to_string(),
                description: Some("prod server".to_string()),
            })
            .expect("create");

        assert_eq!(storage.list_ssh_configs().len(), 1);
        assert_eq!(created.name, "prod");

        let updated = storage
            .upsert_ssh_config(SshConfigInput {
                id: Some(created.id.clone()),
                name: "prod-main".to_string(),
                host: "10.0.0.9".to_string(),
                port: 22,
                username: "admin".to_string(),
                password: "changed".to_string(),
                description: Some(String::new()),
            })
            .expect("update");
        assert_eq!(updated.name, "prod-main");

        storage.delete_ssh_config(&created.id).expect("delete");
        assert!(storage.list_ssh_configs().is_empty());
    }

    #[test]
    fn script_crud_works() {
        let storage = Storage::new(temp_dir("script")).expect("create storage");
        let created = storage
            .upsert_script(ScriptInput {
                id: None,
                name: "health".to_string(),
                path: Some("/opt/health.sh".to_string()),
                command: None,
                description: Some("health check".to_string()),
            })
            .expect("create script");

        assert_eq!(storage.list_scripts().len(), 1);
        assert_eq!(created.path, "/opt/health.sh");

        let updated = storage
            .upsert_script(ScriptInput {
                id: Some(created.id.clone()),
                name: "health-v2".to_string(),
                path: Some(String::new()),
                command: Some("uptime".to_string()),
                description: Some("custom command".to_string()),
            })
            .expect("update script");
        assert_eq!(updated.command, "uptime");

        storage.delete_script(&created.id).expect("delete");
        assert!(storage.list_scripts().is_empty());
    }

    #[test]
    fn ai_config_persistence_works() {
        let storage = Storage::new(temp_dir("ai")).expect("create storage");
        let updated = storage
            .save_ai_config(AiConfigInput {
                base_url: "https://api.openai.com/v1/".to_string(),
                api_key: "key".to_string(),
                model: "gpt-4o-mini".to_string(),
                system_prompt: "assistant".to_string(),
                temperature: 0.4,
                max_tokens: 512,
            })
            .expect("save config");

        assert_eq!(updated.base_url, "https://api.openai.com/v1");
        assert_eq!(storage.get_ai_config().api_key, "key");
    }
}
