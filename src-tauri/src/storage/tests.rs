use super::*;

use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::models::{AiConfigInput, AiProfileInput, ScriptInput, SshConfigInput};

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
    assert_eq!(
        switched.active_profile_id.as_deref(),
        Some(profile_id.as_str())
    );
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

#[test]
fn get_ai_config_prefers_requested_active_profile() {
    const REQUESTED_PROFILE_ID: &str = "cb722d99-ae20-4761-93ab-aa76c4c05c39";

    let root = temp_dir("ai-profile-priority");
    std::fs::create_dir_all(&root).expect("create temp root");

    let payload = serde_json::json!({
        "profiles": [
            {
                "id": "backup-profile",
                "name": "Backup",
                "baseUrl": "https://api.openai.com/v1",
                "apiKey": "backup-key",
                "model": "gpt-4o-mini",
                "systemPrompt": "backup prompt",
                "temperature": 0.7,
                "maxTokens": 1024,
                "createdAt": "2026-03-20T09:46:30.522552100+00:00",
                "updatedAt": "2026-03-20T09:46:30.522552100+00:00"
            },
            {
                "id": REQUESTED_PROFILE_ID,
                "name": "Default",
                "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
                "apiKey": "ark-test-key",
                "model": "doubao-seed-2-0-lite-260215",
                "systemPrompt": "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.",
                "temperature": 0.2,
                "maxTokens": 100000,
                "createdAt": "2026-03-20T09:46:30.522552100+00:00",
                "updatedAt": "2026-03-20T09:46:30.522552100+00:00"
            }
        ],
        "activeProfileId": REQUESTED_PROFILE_ID
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
    assert_eq!(config.base_url, "https://ark.cn-beijing.volces.com/api/v3");
    assert_eq!(config.model, "doubao-seed-2-0-lite-260215");
    assert_eq!(config.max_tokens, 100000);
    assert_eq!(config.temperature, 0.2);
    assert!(config.system_prompt.contains("Linux operations assistant"));
}
