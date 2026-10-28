//! The standalone runtime: the app state plus the session cache that lets a
//! headless process open and reuse SSH connections.
//!
//! The desktop app opens a session per terminal tab the user creates. A CLI
//! or an MCP server has no tabs, so a *target* — an SSH profile name or id —
//! is resolved to a session on demand: the connection is opened once, cached,
//! and reused by every later call that names the same profile. The cached
//! session keeps its working directory across calls, exactly like a tab does.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::common::error::{AppError, AppResult};
use crate::common::time::now_rfc3339;
use crate::domain::agent::service::mcp_server::{ResolveFuture, SessionResolver};
use crate::domain::ssh::model::session_model::ShellSession;
use crate::domain::ssh::model::SshConfig;
use crate::state::AppState;

use super::hostkey::{self, HostKeyPolicy};

/// A headless eShell runtime.
pub(crate) struct StandaloneRuntime {
    state: Arc<AppState>,
    policy: HostKeyPolicy,
    /// SSH profile id → the session opened for it.
    ///
    /// A plain lock, not an async one: the map holds two short strings, so a
    /// read never blocks on anything but another read.
    sessions: RwLock<HashMap<String, String>>,
    /// One connect lock per profile, so concurrent calls share one handshake
    /// instead of opening one connection each.
    connect_locks: std::sync::Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl StandaloneRuntime {
    /// Opens the data directory and prepares the runtime.
    pub(crate) fn new(data_dir: PathBuf, policy: HostKeyPolicy) -> AppResult<Self> {
        let state = Arc::new(AppState::new(data_dir)?);
        Ok(Self {
            state,
            policy,
            sessions: RwLock::new(HashMap::new()),
            connect_locks: std::sync::Mutex::new(HashMap::new()),
        })
    }

    /// The shared app state, for the MCP server and the command line.
    pub(crate) fn state(&self) -> Arc<AppState> {
        Arc::clone(&self.state)
    }

    /// The configured SSH profiles.
    pub(crate) fn profiles(&self) -> Vec<SshConfig> {
        self.state.storage.list_ssh_configs()
    }

    /// Resolves a target to a live session id.
    ///
    /// A target that already names an open session is used as-is. Otherwise it
    /// is matched against the SSH profiles — by id, by name, or by an
    /// unambiguous prefix of a name — and the matching profile is connected.
    pub(crate) async fn resolve_target(&self, target: &str) -> Result<String, String> {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            return Err("missing or empty argument `sessionId`".to_string());
        }
        if self.state.get_session(trimmed).is_ok() {
            return Ok(trimmed.to_string());
        }
        let config = self.find_profile(trimmed).map_err(|error| error.to_string())?;
        self.ensure_session(&config)
            .await
            .map_err(|error| error.to_string())
    }

    /// Matches a target against the configured profiles.
    fn find_profile(&self, target: &str) -> AppResult<SshConfig> {
        let profiles = self.profiles();

        if let Some(config) = profiles.iter().find(|config| config.id == target) {
            return Ok(config.clone());
        }

        let lowered = target.to_lowercase();
        let by_name: Vec<&SshConfig> = profiles
            .iter()
            .filter(|config| config.name.to_lowercase() == lowered)
            .collect();
        match by_name.len() {
            1 => return Ok(by_name[0].clone()),
            0 => {}
            _ => {
                return Err(AppError::Validation(format!(
                    "multiple SSH profiles are named `{target}`: {}",
                    describe(by_name.into_iter())
                )))
            }
        }

        let by_prefix: Vec<&SshConfig> = profiles
            .iter()
            .filter(|config| config.name.to_lowercase().starts_with(&lowered))
            .collect();
        match by_prefix.len() {
            1 => Ok(by_prefix[0].clone()),
            0 => Err(AppError::NotFound(format!(
                "no SSH profile matches `{target}`; known profiles: {}",
                describe(profiles.iter())
            ))),
            _ => Err(AppError::Validation(format!(
                "`{target}` matches several SSH profiles: {}",
                describe(by_prefix.into_iter())
            ))),
        }
    }

    /// Returns the cached session for a profile, opening one if needed.
    async fn ensure_session(&self, config: &SshConfig) -> AppResult<String> {
        if let Some(session_id) = self.cached_session(&config.id) {
            if self.state.get_session(&session_id).is_ok() {
                return Ok(session_id);
            }
        }

        let lock = self.connect_lock(&config.id);
        let _guard = lock.lock().await;

        // Another caller may have connected while this one waited.
        if let Some(session_id) = self.cached_session(&config.id) {
            if self.state.get_session(&session_id).is_ok() {
                return Ok(session_id);
            }
        }

        let session = self.open_session(config).await?;
        self.sessions
            .write()
            .expect("session map poisoned")
            .insert(config.id.clone(), session.id.clone());
        Ok(session.id)
    }

    /// Opens one session for a profile.
    ///
    /// The session record is created first so the connection inherits the
    /// session's cancellation token: closing the session then tears the
    /// connection down with it, the same way a closed tab does.
    async fn open_session(&self, config: &SshConfig) -> AppResult<ShellSession> {
        let now = now_rfc3339();
        let session = ShellSession {
            id: Uuid::new_v4().to_string(),
            config_id: config.id.clone(),
            config_name: config.name.clone(),
            current_dir: String::new(),
            last_output: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        self.state.put_session(session.clone());

        let cancel = match self.state.shell_session_token(&session.id) {
            Ok(token) => token,
            Err(error) => {
                let _ = self.state.remove_session(&session.id);
                return Err(error);
            }
        };

        let connection = match hostkey::connect(&self.state, config, cancel, self.policy).await {
            Ok(connection) => Arc::new(connection),
            Err(error) => {
                let _ = self.state.remove_session(&session.id);
                return Err(error);
            }
        };

        if let Err(error) = self
            .state
            .put_ssh_session(&session.id, Arc::clone(&connection))
        {
            let _ = self.state.remove_session(&session.id);
            return Err(error);
        }

        Ok(session)
    }

    /// The cached session id for a profile, if any.
    fn cached_session(&self, config_id: &str) -> Option<String> {
        self.sessions
            .read()
            .expect("session map poisoned")
            .get(config_id)
            .cloned()
    }

    /// The connect lock for a profile.
    fn connect_lock(&self, config_id: &str) -> Arc<AsyncMutex<()>> {
        let mut guard = self
            .connect_locks
            .lock()
            .expect("connect lock registry poisoned");
        Arc::clone(guard.entry(config_id.to_string()).or_default())
    }
}

/// Renders profiles as `name (id)` for error messages.
fn describe<'a>(configs: impl IntoIterator<Item = &'a SshConfig>) -> String {
    let rendered: Vec<String> = configs
        .into_iter()
        .map(|config| format!("{} ({})", config.name, config.id))
        .collect();
    if rendered.is_empty() {
        return "(none configured)".to_string();
    }
    rendered.join(", ")
}

/// The MCP session resolver backed by a [`StandaloneRuntime`].
///
/// It is what turns a tool call's `sessionId` argument — which may name an
/// SSH profile rather than a session — into a live session id.
pub(crate) struct StandaloneSessionResolver {
    runtime: Arc<StandaloneRuntime>,
}

impl StandaloneSessionResolver {
    pub(crate) fn new(runtime: Arc<StandaloneRuntime>) -> Self {
        Self { runtime }
    }
}

impl SessionResolver for StandaloneSessionResolver {
    fn resolve<'a>(&'a self, target: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move { self.runtime.resolve_target(target).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ssh::model::{SshAuthType, SshConfigInput};

    /// A new profile. The id is left to the store, which assigns one.
    fn input(name: &str, host: &str) -> SshConfigInput {
        SshConfigInput {
            id: None,
            name: name.to_string(),
            host: host.to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: SshAuthType::Password,
            password: "secret".to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: None,
        }
    }

    /// A profile pointing at the in-process test SSH server.
    fn local_input(port: u16) -> SshConfigInput {
        use crate::domain::ssh::test::test_support::{TEST_SSH_PASSWORD, TEST_SSH_USERNAME};
        SshConfigInput {
            id: None,
            name: "Local".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_SSH_USERNAME.to_string(),
            auth_type: SshAuthType::Password,
            password: TEST_SSH_PASSWORD.to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: None,
        }
    }

    fn runtime() -> StandaloneRuntime {
        StandaloneRuntime::new(
            std::env::temp_dir().join(format!("eshell-cli-test-{}", Uuid::new_v4().simple())),
            HostKeyPolicy::AcceptAny,
        )
        .expect("create runtime")
    }

    #[test]
    fn a_profile_is_matched_by_id_and_by_name() {
        let runtime = runtime();
        let saved = runtime
            .state
            .storage
            .upsert_ssh_config(input("Production", "10.0.0.1"))
            .expect("save profile");

        let found = runtime
            .find_profile(&saved.id)
            .expect("matched by id");
        assert_eq!(found.name, "Production");
        let found = runtime
            .find_profile("production")
            .expect("matched by name");
        assert_eq!(found.id, saved.id);
        let found = runtime.find_profile("prod").expect("matched by prefix");
        assert_eq!(found.id, saved.id);
        assert!(runtime.find_profile("nope").is_err());
    }

    #[test]
    fn the_error_lists_the_known_profiles() {
        let runtime = runtime();
        runtime
            .state
            .storage
            .upsert_ssh_config(input("Staging", "10.0.0.2"))
            .expect("save profile");

        let error = runtime
            .find_profile("missing")
            .expect_err("must not resolve");
        let rendered = error.to_string();
        assert!(rendered.contains("Staging"), "{rendered}");
    }

    #[test]
    fn a_config_is_described_for_error_messages() {
        let config = SshConfig {
            id: "id-3".to_string(),
            name: "Edge".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: SshAuthType::Password,
            password: "secret".to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert_eq!(describe([&config]), "Edge (id-3)");
        assert_eq!(describe([]), "(none configured)");
    }

    /// A profile name is connected on demand, the connection is reused, and a
    /// command runs on the remote server.
    ///
    /// The host key is unknown to the runtime, so this also covers the
    /// trust-on-first-use path: the policy records the key and retries.
    #[tokio::test]
    async fn a_profile_is_connected_on_demand_and_the_command_runs() {
        use crate::domain::ssh::test::test_support::TestSshServer;

        let server = TestSshServer::start().await.expect("start test server");
        let runtime = runtime();
        runtime
            .state
            .storage
            .upsert_ssh_config(local_input(server.addr().port()))
            .expect("save profile");

        let session_id = runtime
            .resolve_target("Local")
            .await
            .expect("the profile must be connected on demand");
        assert!(!session_id.is_empty());

        // The connection is cached: the same profile resolves to the same
        // session instead of opening a second connection.
        let again = runtime
            .resolve_target("local")
            .await
            .expect("the cached session must be reused");
        assert_eq!(again, session_id);

        // The test server echoes the command back.
        let state = runtime.state();
        let result = crate::domain::agent::service::mcp_server::execute_command_tool(
            &state,
            &serde_json::json!({ "sessionId": session_id, "command": "echo hi" }),
        )
        .await
        .expect("execute command");
        assert_eq!(result["exitCode"], serde_json::json!(0));
        assert_eq!(
            result["stdout"].as_str().unwrap_or_default().trim(),
            "echo hi"
        );

        server.stop().await;
    }

    /// The MCP surface accepts a profile name where the desktop app expects a
    /// session id, and reports the command result the same way.
    #[tokio::test]
    async fn the_mcp_tool_call_accepts_a_profile_name() {
        use crate::domain::agent::service::mcp_server::McpServer;
        use crate::domain::ssh::test::test_support::TestSshServer;

        let server = TestSshServer::start().await.expect("start test server");
        let runtime = Arc::new(runtime());
        runtime
            .state
            .storage
            .upsert_ssh_config(local_input(server.addr().port()))
            .expect("save profile");

        let state = runtime.state();
        let resolver = Arc::new(StandaloneSessionResolver::new(Arc::clone(&runtime)));
        let mcp = McpServer::standalone(state, resolver);

        let response = mcp
            .handle(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "execute_command",
                    "arguments": { "sessionId": "Local", "command": "echo hi" }
                }
            }))
            .await;

        assert_eq!(response["result"]["isError"], serde_json::json!(false));
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(text.contains("echo hi"), "{text}");

        server.stop().await;
    }
}
