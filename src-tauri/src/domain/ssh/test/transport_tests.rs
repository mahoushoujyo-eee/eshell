//! Unit tests for `ssh/service/transport.rs`: connection-cache identity and
//! eviction, and the error mapping the transport surfaces.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::domain::ssh::consts::*;
use crate::domain::ssh::model::{SshAuthType, SshConfig};
use crate::domain::ssh::service::transport::*;
use crate::state::AppState;

fn test_config() -> SshConfig {
    SshConfig {
        id: "config-1".to_string(),
        name: "Test host".to_string(),
        host: "example.invalid".to_string(),
        port: 22,
        username: "tester".to_string(),
        auth_type: SshAuthType::Password,
        password: String::new(),
        private_key_path: String::new(),
        private_key_passphrase: String::new(),
        use_password_fallback: false,
        jump_host_id: None,
        description: String::new(),
        created_at: crate::common::time::now_rfc3339(),
        updated_at: crate::common::time::now_rfc3339(),
    }
}

/// The endpoint string is what every handshake/auth error names for the user.
#[test]
fn endpoint_includes_user_host_and_port() {
    assert_eq!(endpoint_of(&test_config()), "tester@example.invalid:22");
}

/// A silently dropped connection must be detected, while no idle GC may disconnect a quiet
/// terminal.
#[test]
fn client_config_keeps_keepalive_but_disables_idle_gc() {
    let config = client_config();
    assert_eq!(config.keepalive_interval, Some(SSH_KEEPALIVE_INTERVAL));
    assert_eq!(config.keepalive_interval.unwrap().as_secs(), 20);
    assert_eq!(config.keepalive_max, SSH_KEEPALIVE_MAX);
    assert!(config.inactivity_timeout.is_none());
    assert!(config.nodelay);
}

#[test]
fn jump_chain_rejects_cycles_and_over_depth() {
    assert!(validate_jump_chain(0, &[], "a").is_ok());
    assert!(validate_jump_chain(1, &["a".to_string()], "a").is_err());
    assert!(validate_jump_chain(MAX_JUMP_DEPTH, &[], "a").is_err());
    assert!(
        validate_jump_chain(MAX_JUMP_DEPTH - 1, &["a".to_string(), "b".to_string()], "c")
            .is_ok()
    );
}

#[tokio::test]
async fn cancelled_stream_wakes_an_already_pending_read() {
    use tokio::io::AsyncReadExt;
    let (stream, _peer) = tokio::io::duplex(64);
    let cancel = CancellationToken::new();
    let mut stream = CancellableStream::new(stream, cancel.clone());
    let reader = tokio::spawn(async move { stream.read_u8().await });
    tokio::task::yield_now().await;
    cancel.cancel();
    assert!(timeout(Duration::from_secs(1), reader)
        .await
        .unwrap()
        .unwrap()
        .is_err());
}

#[test]
fn connect_returns_immediately_when_already_cancelled() {
    let state = test_state("connect-cancelled");
    let cancel = CancellationToken::new();
    cancel.cancel();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime");
    let error = runtime
        .block_on(connect(&state, None, &test_config(), cancel))
        .err()
        .map(|error| error.to_string())
        .expect("cancelled connect must fail");

    assert_eq!(
        error,
        format!("runtime error: {SSH_CONNECTION_CANCELLED_MESSAGE}")
    );
}

fn test_state(name: &str) -> Arc<AppState> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("eshell-transport-{name}-{nonce}"));
    Arc::new(AppState::new(root).expect("create app state"))
}
