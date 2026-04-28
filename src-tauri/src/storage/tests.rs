use super::*;

use std::env;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::models::{
    AiApiType, AiApprovalMode, AiConfigInput, AiProfile, AiProfileInput, AiProfilesState,
    ScriptInput, SshConfigInput,
};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock drift")
        .as_nanos();
    env::temp_dir().join(format!("eshell-{name}-{stamp}"))
}

fn is_usable_profile(profile: &AiProfile) -> bool {
    !profile.base_url.trim().is_empty()
        && !profile.api_key.trim().is_empty()
        && !profile.model.trim().is_empty()
        && (0.0..=2.0).contains(&profile.temperature)
        && profile.max_tokens > 0
        && profile.max_context_tokens > 0
}

fn eshell_ai_profiles_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = vec![
        manifest_dir.join(".eshell-data").join("ai_profiles.json"),
        PathBuf::from(".eshell-data").join("ai_profiles.json"),
        PathBuf::from("src-tauri")
            .join(".eshell-data")
            .join("ai_profiles.json"),
    ];
    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(".eshell-data")
                .join("ai_profiles.json")
        })
}

fn first_usable_profile_from_eshell_data() -> AiProfile {
    let path = eshell_ai_profiles_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {} failed: {error}", path.as_path().display()));
    let state: AiProfilesState = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("parse {} failed: {error}", path.as_path().display()));
    state
        .profiles
        .into_iter()
        .find(is_usable_profile)
        .unwrap_or_else(|| panic!("no usable ai profile found in {}", path.as_path().display()))
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
    let profile_seed = first_usable_profile_from_eshell_data();
    let storage = Storage::new(temp_dir("ai-profile")).expect("create storage");
    let created_state = storage
        .save_ai_profile(AiProfileInput {
            id: None,
            name: "SeedProfile".to_string(),
            api_type: profile_seed.api_type.clone(),
            base_url: profile_seed.base_url.clone(),
            api_key: profile_seed.api_key.clone(),
            model: profile_seed.model.clone(),
            system_prompt: profile_seed.system_prompt.clone(),
            temperature: profile_seed.temperature,
            max_tokens: profile_seed.max_tokens,
            max_context_tokens: profile_seed.max_context_tokens,
        })
        .expect("save profile");

    assert!(!created_state.profiles.is_empty());
    let profile_id = created_state
        .profiles
        .iter()
        .find(|item| item.name == "SeedProfile")
        .expect("profile")
        .id
        .clone();

    let switched = storage
        .set_active_ai_profile(&profile_id)
        .expect("set active");
    assert_eq!(
        switched.active_profile_id.as_deref(),
        Some(profile_id.as_str())
    );
    assert_eq!(storage.get_ai_config().model, profile_seed.model);

    let deleted = storage
        .delete_ai_profile(&profile_id)
        .expect("delete profile");
    assert!(!deleted.profiles.is_empty());
}

#[test]
fn save_ai_config_updates_active_profile() {
    let profile_seed = first_usable_profile_from_eshell_data();
    let expected_base_url = profile_seed.base_url.trim_end_matches('/').to_string();
    let storage = Storage::new(temp_dir("ai-config")).expect("create storage");
    let updated = storage
        .save_ai_config(AiConfigInput {
            api_type: profile_seed.api_type.clone(),
            base_url: format!("{expected_base_url}/"),
            api_key: profile_seed.api_key.clone(),
            model: profile_seed.model.clone(),
            system_prompt: profile_seed.system_prompt.clone(),
            temperature: profile_seed.temperature,
            max_tokens: profile_seed.max_tokens,
            max_context_tokens: profile_seed.max_context_tokens,
            approval_mode: AiApprovalMode::AutoExecute,
        })
        .expect("save config");

    let state = storage.list_ai_profiles();
    let active = state
        .active_profile_id
        .and_then(|id| state.profiles.into_iter().find(|item| item.id == id))
        .expect("active profile");
    assert_eq!(updated.base_url, expected_base_url);
    assert_eq!(updated.api_type, profile_seed.api_type);
    assert_eq!(active.model, profile_seed.model);
    assert_eq!(active.api_key, profile_seed.api_key);
    assert_eq!(state.approval_mode, AiApprovalMode::AutoExecute);
}

#[test]
fn get_ai_config_prefers_requested_active_profile() {
    let profile_seed = first_usable_profile_from_eshell_data();
    const REQUESTED_PROFILE_ID: &str = "requested-profile";
    let expected_base_url = profile_seed.base_url.trim_end_matches('/').to_string();
    let requested_name = profile_seed.name.clone();
    let requested_base_url = profile_seed.base_url.clone();
    let requested_api_key = profile_seed.api_key.clone();
    let requested_model = profile_seed.model.clone();
    let requested_system_prompt = profile_seed.system_prompt.clone();
    let requested_temperature = profile_seed.temperature;
    let requested_max_tokens = profile_seed.max_tokens;
    let requested_max_context_tokens = profile_seed.max_context_tokens;

    let root = temp_dir("ai-profile-priority");
    std::fs::create_dir_all(&root).expect("create temp root");

    let payload = serde_json::json!({
        "profiles": [
            {
                "id": "backup-profile",
                "name": "Backup",
                "baseUrl": format!("{expected_base_url}/backup"),
                "apiKey": format!("{}-backup", requested_api_key.as_str()),
                "model": format!("{}-backup", requested_model.as_str()),
                "systemPrompt": "backup prompt",
                "temperature": 0.7,
                "maxTokens": 1024,
                "maxContextTokens": 64000,
                "approvalMode": "auto_execute",
                "createdAt": "2026-03-20T09:46:30.522552100+00:00",
                "updatedAt": "2026-03-20T09:46:30.522552100+00:00"
            },
            {
                "id": REQUESTED_PROFILE_ID,
                "name": requested_name,
                "baseUrl": requested_base_url,
                "apiKey": requested_api_key,
                "model": requested_model,
                "systemPrompt": requested_system_prompt,
                "temperature": requested_temperature,
                "maxTokens": requested_max_tokens,
                "maxContextTokens": requested_max_context_tokens,
                "approvalMode": "require_approval",
                "createdAt": "2026-03-20T09:46:30.522552100+00:00",
                "updatedAt": "2026-03-20T09:46:30.522552100+00:00"
            }
        ],
        "activeProfileId": REQUESTED_PROFILE_ID,
        "approvalMode": "require_approval"
    });

    std::fs::write(
        root.join("ai_profiles.json"),
        serde_json::to_string_pretty(&payload).expect("serialize payload"),
    )
    .expect("write ai_profiles");

    let storage = Storage::new(root).expect("create storage");
    let profiles = storage.list_ai_profiles();
    assert_eq!(
        profiles.active_profile_id.as_deref(),
        Some(REQUESTED_PROFILE_ID)
    );

    let config = storage.get_ai_config();
    assert_eq!(config.base_url, expected_base_url);
    assert_eq!(config.model, profile_seed.model);
    assert_eq!(config.max_tokens, profile_seed.max_tokens);
    assert_eq!(config.max_context_tokens, profile_seed.max_context_tokens);
    assert_eq!(config.temperature, profile_seed.temperature);
    assert_eq!(config.system_prompt, profile_seed.system_prompt);
    assert_eq!(config.api_type, profile_seed.api_type);
    assert_eq!(config.approval_mode, AiApprovalMode::RequireApproval);
}

#[test]
fn legacy_ai_profiles_without_max_context_tokens_get_default_value() {
    let root = temp_dir("ai-profile-legacy-context");
    std::fs::create_dir_all(&root).expect("create temp root");

    let payload = serde_json::json!({
        "profiles": [
            {
                "id": "legacy-profile",
                "name": "Legacy",
                "baseUrl": "https://api.openai.com/v1",
                "apiKey": "legacy-key",
                "model": "gpt-4o-mini",
                "systemPrompt": "legacy prompt",
                "temperature": 0.2,
                "maxTokens": 800,
                "createdAt": "2026-03-20T09:46:30.522552100+00:00",
                "updatedAt": "2026-03-20T09:46:30.522552100+00:00"
            }
        ],
        "activeProfileId": "legacy-profile"
    });

    std::fs::write(
        root.join("ai_profiles.json"),
        serde_json::to_string_pretty(&payload).expect("serialize payload"),
    )
    .expect("write ai_profiles");

    let storage = Storage::new(root).expect("create storage");
    let config = storage.get_ai_config();
    assert_eq!(config.max_context_tokens, 100_000);

    let profiles = storage.list_ai_profiles();
    assert_eq!(profiles.profiles[0].max_context_tokens, 100_000);
    assert_eq!(
        profiles.profiles[0].api_type,
        AiApiType::OpenAiChatCompletions
    );
    assert_eq!(profiles.approval_mode, AiApprovalMode::RequireApproval);
}

#[test]
fn legacy_profile_approval_mode_is_migrated_to_global_setting() {
    let root = temp_dir("ai-profile-legacy-approval");
    std::fs::create_dir_all(&root).expect("create temp root");

    let payload = serde_json::json!({
        "profiles": [
            {
                "id": "legacy-profile",
                "name": "Legacy",
                "baseUrl": "https://api.openai.com/v1",
                "apiKey": "legacy-key",
                "model": "gpt-4o-mini",
                "systemPrompt": "legacy prompt",
                "temperature": 0.2,
                "maxTokens": 800,
                "maxContextTokens": 100000,
                "approvalMode": "auto_execute",
                "createdAt": "2026-03-20T09:46:30.522552100+00:00",
                "updatedAt": "2026-03-20T09:46:30.522552100+00:00"
            }
        ],
        "activeProfileId": "legacy-profile"
    });

    std::fs::write(
        root.join("ai_profiles.json"),
        serde_json::to_string_pretty(&payload).expect("serialize payload"),
    )
    .expect("write ai_profiles");

    let storage = Storage::new(root).expect("create storage");
    let profiles = storage.list_ai_profiles();
    let config = storage.get_ai_config();

    assert_eq!(profiles.approval_mode, AiApprovalMode::AutoExecute);
    assert_eq!(config.approval_mode, AiApprovalMode::AutoExecute);
}

#[test]
fn save_ai_approval_mode_updates_global_setting_only() {
    let profile_seed = first_usable_profile_from_eshell_data();
    let storage = Storage::new(temp_dir("ai-approval-mode")).expect("create storage");

    let created_state = storage
        .save_ai_profile(AiProfileInput {
            id: None,
            name: "SeedProfile".to_string(),
            api_type: profile_seed.api_type.clone(),
            base_url: profile_seed.base_url.clone(),
            api_key: profile_seed.api_key.clone(),
            model: profile_seed.model.clone(),
            system_prompt: profile_seed.system_prompt.clone(),
            temperature: profile_seed.temperature,
            max_tokens: profile_seed.max_tokens,
            max_context_tokens: profile_seed.max_context_tokens,
        })
        .expect("save profile");
    let profile_count = created_state.profiles.len();

    let updated_state = storage
        .save_ai_approval_mode(AiApprovalMode::AutoExecute)
        .expect("save approval mode");

    assert_eq!(updated_state.approval_mode, AiApprovalMode::AutoExecute);
    assert_eq!(updated_state.profiles.len(), profile_count);
    assert_eq!(
        storage.get_ai_config().approval_mode,
        AiApprovalMode::AutoExecute
    );
}
