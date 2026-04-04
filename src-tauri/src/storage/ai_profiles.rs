use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    now_rfc3339, AiConfig, AiConfigInput, AiProfile, AiProfileInput, AiProfilesState,
};

use super::io::write_json_pretty;
use super::Storage;

impl Storage {
    /// Returns AI profile collection and active profile id.
    pub fn list_ai_profiles(&self) -> AiProfilesState {
        self.ai_profiles
            .read()
            .expect("ai profiles lock poisoned")
            .clone()
    }

    /// Creates or updates an AI profile and persists the profile store.
    pub fn save_ai_profile(&self, input: AiProfileInput) -> AppResult<AiProfilesState> {
        validate_ai_payload(
            Some(input.name.as_str()),
            &input.base_url,
            &input.model,
            input.temperature,
        )?;
        if input.max_tokens == 0 {
            return Err(AppError::Validation(
                "maxTokens must be greater than 0".to_string(),
            ));
        }
        if input.max_context_tokens == 0 {
            return Err(AppError::Validation(
                "maxContextTokens must be greater than 0".to_string(),
            ));
        }

        let mut guard = self.ai_profiles.write().expect("ai profiles lock poisoned");
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
                    max_context_tokens: input.max_context_tokens,
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
                    max_context_tokens: input.max_context_tokens,
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
        let mut guard = self.ai_profiles.write().expect("ai profiles lock poisoned");
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
        let mut guard = self.ai_profiles.write().expect("ai profiles lock poisoned");
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
            return Err(AppError::Validation(
                "maxTokens must be greater than 0".to_string(),
            ));
        }
        if input.max_context_tokens == 0 {
            return Err(AppError::Validation(
                "maxContextTokens must be greater than 0".to_string(),
            ));
        }

        let mut guard = self.ai_profiles.write().expect("ai profiles lock poisoned");
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
            max_context_tokens: input.max_context_tokens,
            created_at: existing.created_at.clone(),
            updated_at: now,
        };
        guard.profiles[index] = updated.clone();

        write_json_pretty(&self.ai_profiles_path, &*guard)?;
        Ok(config_from_profile(&updated))
    }
}

pub(super) fn ensure_ai_profiles_state(state: &mut AiProfilesState, fallback_config: &AiConfig) {
    if state.profiles.is_empty() {
        state
            .profiles
            .push(profile_from_config(fallback_config, "Default"));
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
    if profile.max_context_tokens == 0 {
        profile.max_context_tokens = defaults.max_context_tokens;
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
        max_context_tokens: config.max_context_tokens,
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
        max_context_tokens: profile.max_context_tokens,
        updated_at: profile.updated_at.clone(),
    }
}
