use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    now_rfc3339, AiConfig, AiConfigInput, AiProfile, AiProfileInput, AiProfilesState,
    ScriptDefinition, ScriptInput, SshConfig, SshConfigInput,
};

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

        let ssh_configs_path = root.join("ssh_configs.json");
        let scripts_path = root.join("scripts.json");
        let ai_profiles_path = root.join("ai_profiles.json");
        let legacy_ai_config_path = root.join("ai_config.json");

        let ssh_configs = read_json_or_default::<Vec<SshConfig>>(&ssh_configs_path)?;
        let scripts = read_json_or_default::<Vec<ScriptDefinition>>(&scripts_path)?;
        let mut ai_profiles = read_json_or_default::<AiProfilesState>(&ai_profiles_path)?;

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

    /// Returns AI profile collection and active profile id.
    pub fn list_ai_profiles(&self) -> AiProfilesState {
        self.ai_profiles
            .read()
            .expect("ai profiles lock poisoned")
            .clone()
    }

    /// Creates or updates an AI profile and persists the profile store.
    pub fn save_ai_profile(&self, input: AiProfileInput) -> AppResult<AiProfilesState> {
        validate_ai_payload(Some(input.name.as_str()), &input.base_url, &input.model, input.temperature)?;
        if input.max_tokens == 0 {
            return Err(AppError::Validation("maxTokens must be greater than 0".to_string()));
        }

        let mut guard = self
            .ai_profiles
            .write()
            .expect("ai profiles lock poisoned");
        ensure_ai_profiles_state(&mut guard, &AiConfig::default());
        let now = now_rfc3339();

        let profile = match input.id.as_deref() {
            Some(id) => {
                let index = guard
                    .profiles
                    .iter()
                    .position(|item| item.id == id)
                    .ok_or_else(|| AppError::NotFound(format!("ai profile {id}")))?;
                let existing = &guard.profiles[index];
                let updated = AiProfile {
                    id: existing.id.clone(),
                    name: input.name.trim().to_string(),
                    base_url: normalize_base_url(&input.base_url),
                    api_key: input.api_key.trim().to_string(),
                    model: input.model.trim().to_string(),
                    system_prompt: input.system_prompt.trim().to_string(),
                    temperature: input.temperature,
                    max_tokens: input.max_tokens,
                    created_at: existing.created_at.clone(),
                    updated_at: now,
                };
                guard.profiles[index] = updated.clone();
                updated
            }
            None => {
                let created = AiProfile {
                    id: Uuid::new_v4().to_string(),
                    name: input.name.trim().to_string(),
                    base_url: normalize_base_url(&input.base_url),
                    api_key: input.api_key.trim().to_string(),
                    model: input.model.trim().to_string(),
                    system_prompt: input.system_prompt.trim().to_string(),
                    temperature: input.temperature,
                    max_tokens: input.max_tokens,
                    created_at: now.clone(),
                    updated_at: now,
                };
                guard.profiles.push(created.clone());
                created
            }
        };

        if guard.active_profile_id.is_none() {
            guard.active_profile_id = Some(profile.id);
        }
        write_json_pretty(&self.ai_profiles_path, &*guard)?;
        Ok(guard.clone())
    }

    /// Deletes an AI profile by id. Keeps at least one profile available.
    pub fn delete_ai_profile(&self, id: &str) -> AppResult<AiProfilesState> {
        let mut guard = self
            .ai_profiles
            .write()
            .expect("ai profiles lock poisoned");
        let before = guard.profiles.len();
        guard.profiles.retain(|item| item.id != id);
        if guard.profiles.len() == before {
            return Err(AppError::NotFound(format!("ai profile {id}")));
        }

        ensure_ai_profiles_state(&mut guard, &AiConfig::default());
        write_json_pretty(&self.ai_profiles_path, &*guard)?;
        Ok(guard.clone())
    }

    /// Sets one profile as active for AI chat calls.
    pub fn set_active_ai_profile(&self, id: &str) -> AppResult<AiProfilesState> {
        let mut guard = self
            .ai_profiles
            .write()
            .expect("ai profiles lock poisoned");
        if !guard.profiles.iter().any(|item| item.id == id) {
            return Err(AppError::NotFound(format!("ai profile {id}")));
        }
        guard.active_profile_id = Some(id.to_string());
        write_json_pretty(&self.ai_profiles_path, &*guard)?;
        Ok(guard.clone())
    }

    /// Returns active AI configuration resolved from active profile.
    pub fn get_ai_config(&self) -> AiConfig {
        let mut snapshot = self
            .ai_profiles
            .read()
            .expect("ai profiles lock poisoned")
            .clone();
        ensure_ai_profiles_state(&mut snapshot, &AiConfig::default());
        snapshot
            .active_profile_id
            .as_ref()
            .and_then(|id| snapshot.profiles.iter().find(|item| item.id == *id))
            .map(config_from_profile)
            .unwrap_or_default()
    }

    /// Updates active profile using old single-config API for compatibility.
    pub fn save_ai_config(&self, input: AiConfigInput) -> AppResult<AiConfig> {
        validate_ai_payload(None, &input.base_url, &input.model, input.temperature)?;
        if input.max_tokens == 0 {
            return Err(AppError::Validation("maxTokens must be greater than 0".to_string()));
        }

        let mut guard = self
            .ai_profiles
            .write()
            .expect("ai profiles lock poisoned");
        ensure_ai_profiles_state(&mut guard, &AiConfig::default());

        let active_id = guard
            .active_profile_id
            .clone()
            .ok_or_else(|| AppError::Runtime("missing active AI profile".to_string()))?;
        let index = guard
            .profiles
            .iter()
            .position(|item| item.id == active_id)
            .ok_or_else(|| AppError::Runtime("active AI profile not found".to_string()))?;

        let now = now_rfc3339();
        let existing = &guard.profiles[index];
        let updated = AiProfile {
            id: existing.id.clone(),
            name: existing.name.clone(),
            base_url: normalize_base_url(&input.base_url),
            api_key: input.api_key.trim().to_string(),
            model: input.model.trim().to_string(),
            system_prompt: input.system_prompt.trim().to_string(),
            temperature: input.temperature,
            max_tokens: input.max_tokens,
            created_at: existing.created_at.clone(),
            updated_at: now,
        };
        guard.profiles[index] = updated.clone();

        write_json_pretty(&self.ai_profiles_path, &*guard)?;
        Ok(config_from_profile(&updated))
    }
}

fn ensure_ai_profiles_state(state: &mut AiProfilesState, fallback_config: &AiConfig) {
    if state.profiles.is_empty() {
        state.profiles.push(profile_from_config(fallback_config, "Default"));
    }
    for profile in state.profiles.iter_mut() {
        normalize_profile(profile);
    }
    let active_valid = state
        .active_profile_id
        .as_ref()
        .map(|id| state.profiles.iter().any(|item| item.id == *id))
        .unwrap_or(false);
    if !active_valid {
        state.active_profile_id = state.profiles.first().map(|item| item.id.clone());
    }
}

fn validate_ai_payload(
    name: Option<&str>,
    base_url: &str,
    model: &str,
    temperature: f64,
) -> AppResult<()> {
    if let Some(value) = name {
        if value.trim().is_empty() {
            return Err(AppError::Validation("name cannot be empty".to_string()));
        }
    }
    if base_url.trim().is_empty() {
        return Err(AppError::Validation("baseUrl cannot be empty".to_string()));
    }
    if model.trim().is_empty() {
        return Err(AppError::Validation("model cannot be empty".to_string()));
    }
    if !(0.0..=2.0).contains(&temperature) {
        return Err(AppError::Validation(
            "temperature must be between 0 and 2".to_string(),
        ));
    }
    Ok(())
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn normalize_profile(profile: &mut AiProfile) {
    let defaults = AiConfig::default();
    if profile.id.trim().is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    profile.name = if profile.name.trim().is_empty() {
        "Default".to_string()
    } else {
        profile.name.trim().to_string()
    };
    profile.base_url = {
        let next = normalize_base_url(&profile.base_url);
        if next.is_empty() {
            defaults.base_url
        } else {
            next
        }
    };
    profile.api_key = profile.api_key.trim().to_string();
    profile.model = if profile.model.trim().is_empty() {
        defaults.model
    } else {
        profile.model.trim().to_string()
    };
    profile.system_prompt = if profile.system_prompt.trim().is_empty() {
        defaults.system_prompt
    } else {
        profile.system_prompt.trim().to_string()
    };
    if !(0.0..=2.0).contains(&profile.temperature) {
        profile.temperature = defaults.temperature;
    }
    if profile.max_tokens == 0 {
        profile.max_tokens = defaults.max_tokens;
    }
    if profile.created_at.trim().is_empty() {
        profile.created_at = now_rfc3339();
    }
    if profile.updated_at.trim().is_empty() {
        profile.updated_at = now_rfc3339();
    }
}

fn profile_from_config(config: &AiConfig, name: &str) -> AiProfile {
    let now = now_rfc3339();
    AiProfile {
        id: Uuid::new_v4().to_string(),
        name: if name.trim().is_empty() {
            "Default".to_string()
        } else {
            name.trim().to_string()
        },
        base_url: normalize_base_url(&config.base_url),
        api_key: config.api_key.clone(),
        model: config.model.clone(),
        system_prompt: config.system_prompt.clone(),
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        created_at: now.clone(),
        updated_at: now,
    }
}

fn config_from_profile(profile: &AiProfile) -> AiConfig {
    AiConfig {
        base_url: profile.base_url.clone(),
        api_key: profile.api_key.clone(),
        model: profile.model.clone(),
        system_prompt: profile.system_prompt.clone(),
        temperature: profile.temperature,
        max_tokens: profile.max_tokens,
        updated_at: profile.updated_at.clone(),
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
    fn ai_profile_crud_works() {
        let storage = Storage::new(temp_dir("ai-profile")).expect("create storage");
        let created_state = storage
            .save_ai_profile(AiProfileInput {
                id: None,
                name: "ModelScope".to_string(),
                base_url: "https://api-inference.modelscope.cn/v1".to_string(),
                api_key: "key".to_string(),
                model: "moonshotai/Kimi-K2.5".to_string(),
                system_prompt: "assistant".to_string(),
                temperature: 0.2,
                max_tokens: 800,
            })
            .expect("save profile");

        assert!(!created_state.profiles.is_empty());
        let profile_id = created_state
            .profiles
            .iter()
            .find(|item| item.name == "ModelScope")
            .expect("profile")
            .id
            .clone();

        let switched = storage
            .set_active_ai_profile(&profile_id)
            .expect("set active");
        assert_eq!(switched.active_profile_id.as_deref(), Some(profile_id.as_str()));
        assert_eq!(storage.get_ai_config().model, "moonshotai/Kimi-K2.5");

        let deleted = storage
            .delete_ai_profile(&profile_id)
            .expect("delete profile");
        assert!(!deleted.profiles.is_empty());
    }

    #[test]
    fn save_ai_config_updates_active_profile() {
        let storage = Storage::new(temp_dir("ai-config")).expect("create storage");
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

        let state = storage.list_ai_profiles();
        let active = state
            .active_profile_id
            .and_then(|id| state.profiles.into_iter().find(|item| item.id == id))
            .expect("active profile");
        assert_eq!(updated.base_url, "https://api.openai.com/v1");
        assert_eq!(active.model, "gpt-4o-mini");
    }
}
