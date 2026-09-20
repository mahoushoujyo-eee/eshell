use super::*;

use std::env;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::scripts::model::ScriptInput;
use crate::domain::ssh::model::{SshAuthType, SshConfigInput, TrustSshHostKeyInput};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock drift")
        .as_nanos();
    env::temp_dir().join(format!("eshell-{name}-{stamp}"))
}

// Storage unit tests must not depend on a developer's real API credentials.

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
            auth_type: SshAuthType::Password,
            password: "secret".to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
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
            auth_type: SshAuthType::Password,
            password: "changed".to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: Some(String::new()),
        })
        .expect("update");
    assert_eq!(updated.name, "prod-main");

    storage.delete_ssh_config(&created.id).expect("delete");
    assert!(storage.list_ssh_configs().is_empty());
}

#[test]
fn ssh_config_private_key_profile_is_persisted() {
    let storage = Storage::new(temp_dir("ssh-key")).expect("create storage");
    let created = storage
        .upsert_ssh_config(SshConfigInput {
            id: None,
            name: "key-prod".to_string(),
            host: "example.com".to_string(),
            port: 2222,
            username: "deploy".to_string(),
            auth_type: SshAuthType::PrivateKey,
            password: String::new(),
            private_key_path: "C:\\Users\\me\\.ssh\\id_ed25519".to_string(),
            private_key_passphrase: "phrase".to_string(),
            use_password_fallback: false,
            jump_host_id: None,
            description: None,
        })
        .expect("create key profile");

    assert_eq!(created.auth_type, SshAuthType::PrivateKey);
    assert_eq!(created.private_key_path, "C:\\Users\\me\\.ssh\\id_ed25519");
    assert_eq!(created.private_key_passphrase, "phrase");
}

#[test]
fn ssh_config_private_key_requires_key_path() {
    let storage = Storage::new(temp_dir("ssh-key-validation")).expect("create storage");
    let err = storage
        .upsert_ssh_config(SshConfigInput {
            id: None,
            name: "missing-key".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_type: SshAuthType::PrivateKey,
            password: String::new(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: None,
        })
        .expect_err("missing key path should fail");

    assert!(err.to_string().contains("private key path"));
}

#[test]
fn ssh_config_legacy_password_profile_deserializes_with_defaults() {
    let raw = r#"{
        "id": "legacy",
        "name": "legacy",
        "host": "10.0.0.8",
        "port": 22,
        "username": "root",
        "password": "secret",
        "description": "",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    }"#;
    let config: crate::domain::ssh::model::SshConfig = serde_json::from_str(raw).expect("deserialize legacy");

    assert_eq!(config.auth_type, SshAuthType::Password);
    assert!(config.private_key_path.is_empty());
    assert!(!config.use_password_fallback);
}

#[test]
fn ssh_known_host_trust_is_shared_by_host_and_port() {
    let storage = Storage::new(temp_dir("known-host")).expect("create storage");
    let trusted = storage
        .trust_ssh_host_key(TrustSshHostKeyInput {
            host: "Example.COM ".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:first".to_string(),
        })
        .expect("trust host");

    assert_eq!(trusted.host, "example.com");

    let updated = storage
        .trust_ssh_host_key(TrustSshHostKeyInput {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:second".to_string(),
        })
        .expect("replace host key");

    let found = storage
        .find_known_host("EXAMPLE.com", 22)
        .expect("known host");
    assert_eq!(found.fingerprint, "SHA256:second");
    assert_eq!(found.created_at, trusted.created_at);
    assert_eq!(found.updated_at, updated.updated_at);
}

#[test]
fn agent_contexts_are_stored_as_markdown_files() {
    let storage = Storage::new(temp_dir("agent-context")).expect("create storage");

    let global = storage
        .save_agent_context(None, "global notes")
        .expect("save global context");
    assert!(global.path.ends_with("AGENTS.md"));

    let server = storage
        .save_agent_context(Some("server-1"), "server notes")
        .expect("save server context");
    assert!(
        server.path.ends_with("agent\\server-1.md") || server.path.ends_with("agent/server-1.md")
    );
    assert!(
        storage
            .get_agent_context(Some("server-1"))
            .expect("read back server context")
            .content
            == "server notes"
    );
}

/// Both bundled skills must land on first run: the agent reads them from
/// `.eshell-data/agent/skills/<name>/SKILL.md`, so a missing seed is a
/// silently absent capability rather than a visible error.
#[test]
fn bundled_skills_are_seeded_on_first_run() {
    let storage = Storage::new(temp_dir("agent-skills")).expect("create storage");
    let skills = storage.data_dir().join("agent").join("skills");

    for name in ["eshell-config", "eshell-plugin-dev"] {
        let path = skills.join(name).join("SKILL.md");
        assert!(path.exists(), "{} was not seeded at {}", name, path.display());
        let content = std::fs::read_to_string(&path).expect("read seeded skill");
        assert!(
            content.contains(&format!("name: {name}")),
            "{name} frontmatter does not name the skill"
        );
    }

    // The config skill's companion doc ships with it.
    assert!(skills
        .join("eshell-config")
        .join("docs")
        .join("acp_agent.md")
        .exists());
}

/// A user or agent edit must survive the next launch: the seed only writes
/// when the file is missing.
#[test]
fn seeded_skills_are_never_overwritten() {
    let root = temp_dir("agent-skills-keep");
    let storage = Storage::new(root.clone()).expect("create storage");
    let skill_md = storage
        .data_dir()
        .join("agent")
        .join("skills")
        .join("eshell-plugin-dev")
        .join("SKILL.md");
    std::fs::write(&skill_md, "edited by the user").expect("edit skill");

    // A second construction is what a relaunch does.
    let _reopened = Storage::new(root).expect("reopen storage");
    assert_eq!(
        std::fs::read_to_string(&skill_md).expect("read skill"),
        "edited by the user"
    );
}

/// Reloading picks up an edit made on disk, which is the whole point: the
/// user (or an agent) edits a JSON file and the app sees it without a restart.
#[test]
fn reload_picks_up_an_external_edit() {
    let root = temp_dir("reload-edit");
    let storage = Storage::new(root.clone()).expect("create storage");

    let path = root.join("ssh_configs.json");
    std::fs::write(
        &path,
        r#"[{"id":"s1","name":"edited","host":"h","port":22,"username":"u",
             "authType":"password","password":"p","description":"",
             "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]"#,
    )
    .expect("write config");

    assert!(storage.list_ssh_configs().is_empty(), "not loaded yet");

    let outcome = storage.reload_config(ConfigFile::SshConfigs);
    assert_eq!(outcome.file, "sshConfigs");
    assert!(outcome.changed, "the edit must be reported as a change");
    assert!(outcome.error.is_none());
    assert_eq!(storage.list_ssh_configs().len(), 1);
    assert_eq!(storage.list_ssh_configs()[0].name, "edited");
}

/// Reloading an unchanged file reports no change, so a caller can tell a
/// no-op reload from a real one.
#[test]
fn reload_reports_no_change_when_the_file_is_unchanged() {
    let root = temp_dir("reload-noop");
    let storage = Storage::new(root).expect("create storage");

    let outcome = storage.reload_config(ConfigFile::SshConfigs);
    assert!(!outcome.changed);
    assert!(outcome.error.is_none());
}

/// A malformed file is reported, never applied: the in-memory value must
/// survive so a half-written file cannot wipe the user's servers.
#[test]
fn reload_reports_a_parse_failure_without_clobbering_state() {
    let root = temp_dir("reload-bad");
    let storage = Storage::new(root.clone()).expect("create storage");

    storage
        .upsert_ssh_config(crate::domain::ssh::model::SshConfigInput {
            id: None,
            name: "keep-me".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: SshAuthType::Password,
            password: "secret".to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: None,
        })
        .expect("seed a config");

    std::fs::write(root.join("ssh_configs.json"), "{ this is not json").expect("write garbage");

    let outcome = storage.reload_config(ConfigFile::SshConfigs);
    assert!(outcome.error.is_some(), "a parse failure must be reported");
    assert!(!outcome.changed);
    assert_eq!(
        storage.list_ssh_configs().len(),
        1,
        "the last good value must survive a bad file"
    );
    assert_eq!(storage.list_ssh_configs()[0].name, "keep-me");
}

/// A missing file leaves the current value alone rather than clearing it.
#[test]
fn reload_of_a_missing_file_keeps_the_current_value() {
    let root = temp_dir("reload-missing");
    let storage = Storage::new(root.clone()).expect("create storage");

    storage
        .upsert_ssh_config(crate::domain::ssh::model::SshConfigInput {
            id: None,
            name: "still-here".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: SshAuthType::Password,
            password: "secret".to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: None,
        })
        .expect("seed a config");

    std::fs::remove_file(root.join("ssh_configs.json")).expect("delete the file");

    let outcome = storage.reload_config(ConfigFile::SshConfigs);
    assert!(outcome.missing);
    assert!(!outcome.changed);
    assert!(outcome.error.is_none(), "a missing file is not an error");
    assert_eq!(storage.list_ssh_configs().len(), 1);
}

/// Reloading everything visits each file and one bad file does not stop the
/// others.
#[test]
fn reload_all_visits_every_file_and_isolates_failures() {
    let root = temp_dir("reload-all");
    let storage = Storage::new(root.clone()).expect("create storage");

    // Break one file; the rest must still be reported.
    std::fs::write(root.join("scripts.json"), "not json at all").expect("write garbage");

    let outcomes = storage.reload_all_configs();
    assert_eq!(outcomes.len(), ConfigFile::ALL.len());

    let scripts = outcomes
        .iter()
        .find(|outcome| outcome.file == "scripts")
        .expect("scripts outcome");
    assert!(scripts.error.is_some(), "the broken file is reported");

    let ssh = outcomes
        .iter()
        .find(|outcome| outcome.file == "sshConfigs")
        .expect("ssh outcome");
    assert!(ssh.error.is_none(), "a sibling failure must not leak");

    // Every reloadable file is named, and the wire names round-trip.
    for outcome in &outcomes {
        assert!(
            ConfigFile::parse(&outcome.file).is_ok(),
            "{} must round-trip through ConfigFile::parse",
            outcome.file
        );
    }
}

/// An unknown file name is a validation error, not a silent no-op.
#[test]
fn reload_rejects_an_unknown_file_name() {
    let error = ConfigFile::parse("nope").expect_err("unknown name must be rejected");
    assert!(format!("{error:?}").contains("nope"), "{error:?}");
}
