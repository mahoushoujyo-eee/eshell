//! Unit tests for the shared application state: session bookkeeping,
//! the SSH connection cache, PTY channels and cancellation tokens.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::common::time::now_rfc3339;
use crate::domain::ssh::model::{SshAuthType, SshConfig, TrustSshHostKeyInput};
use crate::domain::ssh::test::test_support::{TestSshServer, TEST_SSH_PASSWORD, TEST_SSH_USERNAME};
use crate::domain::ssh::service::transport;
use crate::domain::ssh::service::transport::Connection;
use crate::domain::ssh::model::session_model::ShellSession;
use crate::state::{AppState, PtyCommand, SharedSshSession};

/// An in-process SSH server plus the host-key trust and config needed to reach it.
///
/// Every fixture owns its own server, so tests open real localhost russh
/// connections instead of a libssh2 dummy. Keep it alive for the whole test:
/// dropping it only leaks the (task-held) listener, but the connections the
/// tests opened are shut down explicitly through the state under test.
struct TestFixture {
    _server: TestSshServer,
    config: SshConfig,
}

impl TestFixture {
    async fn start(state: &AppState) -> Self {
        let server = TestSshServer::start().await.expect("start test ssh server");
        state
            .storage
            .trust_ssh_host_key(TrustSshHostKeyInput {
                host: "127.0.0.1".to_string(),
                port: server.addr().port(),
                key_type: server.key_type().to_string(),
                fingerprint: server.fingerprint().to_string(),
            })
            .expect("trust test host key");

        let config = SshConfig {
            id: "config-1".to_string(),
            name: "Test host".to_string(),
            host: "127.0.0.1".to_string(),
            port: server.addr().port(),
            username: TEST_SSH_USERNAME.to_string(),
            auth_type: SshAuthType::Password,
            password: TEST_SSH_PASSWORD.to_string(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };

        Self {
            _server: server,
            config,
        }
    }
}

/// Opens one real connection to the fixture's localhost server.
async fn open_connection(state: &Arc<AppState>, config: &SshConfig) -> AppResult<Connection> {
    transport::connect(state, None, config, CancellationToken::new()).await
}

/// Builds a `get_or_insert_ssh_session` connector for a fixture.
///
/// The fresh clones keep the connector independent of the receiver borrow,
/// which `get_or_insert_ssh_session` holds while it calls the closure.
macro_rules! connector {
    ($state:expr, $config:expr) => {{
        let state = Arc::clone(&$state);
        let config = $config.clone();
        move || async move {
            transport::connect(&state, None, &config, CancellationToken::new()).await
        }
    }};
}

fn temp_state(name: &str) -> AppState {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("eshell-state-{name}-{nonce}"));
    AppState::new(root).expect("create app state")
}

fn shell_session(id: &str) -> ShellSession {
    shell_session_created_at(id, &now_rfc3339())
}

fn shell_session_created_at(id: &str, created_at: &str) -> ShellSession {
    ShellSession {
        id: id.to_string(),
        config_id: "config-1".to_string(),
        config_name: "Test host".to_string(),
        current_dir: "/home/test".to_string(),
        last_output: String::new(),
        created_at: created_at.to_string(),
        updated_at: created_at.to_string(),
    }
}

/// The tab bar renders `list_sessions` directly, so an unordered result made
/// tabs jump around whenever the frontend reloaded the session list.
#[test]
fn list_sessions_is_ordered_by_creation_and_stable_across_calls() {
    let state = temp_state("session-order");
    state.put_session(shell_session_created_at(
        "session-c",
        "2026-09-14T06:44:28.000000000+00:00",
    ));
    state.put_session(shell_session_created_at(
        "session-a",
        "2026-09-14T06:01:08.000000000+00:00",
    ));
    state.put_session(shell_session_created_at(
        "session-b",
        "2026-09-14T06:01:30.000000000+00:00",
    ));

    let ids: Vec<String> = state.list_sessions().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, vec!["session-a", "session-b", "session-c"]);

    // Repeated reads must not reshuffle, and neither must an unrelated insert.
    assert_eq!(
        state
            .list_sessions()
            .into_iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        ids
    );
    state.put_session(shell_session_created_at(
        "session-d",
        "2026-09-14T07:00:00.000000000+00:00",
    ));
    assert_eq!(
        state
            .list_sessions()
            .into_iter()
            .map(|s| s.id)
            .take(3)
            .collect::<Vec<_>>(),
        ids
    );
}

/// An SSH handshake takes seconds. It must not be performed while holding the
/// shared session map, or every other tab freezes until it finishes.
#[tokio::test]
async fn connecting_one_tab_does_not_block_another_tab() {
    let state = Arc::new(temp_state("ssh-parallel-connect"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));
    state.put_session(shell_session("session-2"));

    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel::<()>();

    let gate_state = Arc::clone(&state);
    let gate_config = config.clone();
    let slow = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            state
                .get_or_insert_ssh_session("session-1", move || async move {
                    let _ = started_tx.send(());
                    let _ = release_rx.await;
                    open_connection(&gate_state, &gate_config).await
                })
                .await
        })
    };

    started_rx.await.expect("slow connect started");

    // Run the second tab's connect under a timeout so a regression shows up as
    // a clean failure instead of hanging the test binary.
    let fast = tokio::time::timeout(
        Duration::from_secs(10),
        state.get_or_insert_ssh_session("session-2", connector!(state, config)),
    )
    .await
    .expect("a tab must be able to connect while another tab is still handshaking");
    assert!(fast.is_ok());

    let _ = release_tx.send(());
    slow.await
        .expect("join slow connect")
        .expect("slow connect");
}

/// A fresh tab fires several operations at once (SFTP listing, status poll).
/// They must share one handshake instead of racing into several connections.
#[tokio::test]
async fn concurrent_callers_for_one_tab_open_a_single_connection() {
    let state = Arc::new(temp_state("ssh-single-connect"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));
    let connects = Arc::new(AtomicUsize::new(0));

    let handles: Vec<_> = (0..4)
        .map(|_| {
            let state = Arc::clone(&state);
            let config = config.clone();
            let connects = Arc::clone(&connects);
            tokio::spawn(async move {
                let connect_state = Arc::clone(&state);
                let connect_config = config.clone();
                let connects = Arc::clone(&connects);
                state
                    .get_or_insert_ssh_session("session-1", move || async move {
                        connects.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        open_connection(&connect_state, &connect_config).await
                    })
                    .await
                    .expect("cached ssh session")
            })
        })
        .collect();

    let sessions: Vec<SharedSshSession> = {
        let mut sessions = Vec::new();
        for handle in handles {
            sessions.push(handle.await.expect("join"));
        }
        sessions
    };

    assert_eq!(connects.load(Ordering::SeqCst), 1);
    for session in &sessions {
        assert!(Arc::ptr_eq(session, &sessions[0]));
    }
}

/// Closing a tab mid-handshake must not leave an orphan connection behind that
/// nothing will ever close, nor let the late connection resurrect the cache.
#[tokio::test]
async fn connection_finished_after_session_removal_is_not_cached() {
    let state = Arc::new(temp_state("ssh-removed-midconnect"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));

    let connect_state = Arc::clone(&state);
    let connect_config = config.clone();
    let result = state
        .get_or_insert_ssh_session("session-1", move || async move {
            connect_state
                .remove_session("session-1")
                .expect("remove shell");
            open_connection(&connect_state, &connect_config).await
        })
        .await;

    assert!(matches!(result, Err(AppError::NotFound(_))));
    assert!(!state.has_ssh_session("session-1"));
}

/// A caller queued behind another tab's handshake must not start a fresh
/// handshake after the tab is closed, even if it already read the tab token.
#[tokio::test]
async fn waiting_callers_do_not_start_a_handshake_after_removal() {
    let state = Arc::new(temp_state("ssh-close-wait"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));

    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel::<()>();

    let gate_state = Arc::clone(&state);
    let gate_config = config.clone();
    let first = tokio::spawn({
        let state = Arc::clone(&state);
        async move {
            state
                .get_or_insert_ssh_session("session-1", move || async move {
                    let _ = started_tx.send(());
                    let _ = release_rx.await;
                    open_connection(&gate_state, &gate_config).await
                })
                .await
        }
    });
    started_rx.await.expect("first handshake started");

    // Second caller queues behind the per-tab connect lock.
    let waiter = tokio::spawn({
        let state = Arc::clone(&state);
        let config = config.clone();
        async move {
            let connect_state = Arc::clone(&state);
            let connect_config = config.clone();
            state
                .get_or_insert_ssh_session("session-1", move || async move {
                    open_connection(&connect_state, &connect_config).await
                })
                .await
        }
    });
    // Let the waiter reach the lock wait before the tab disappears.
    tokio::task::yield_now().await;

    state.remove_session("session-1").expect("remove shell");
    let _ = release_tx.send(());

    let first_result = first.await.expect("join first");
    let waiter_result = waiter.await.expect("join waiter");
    assert!(matches!(first_result, Err(AppError::NotFound(_))));
    assert!(matches!(waiter_result, Err(AppError::NotFound(_))));
    assert!(!state.has_ssh_session("session-1"));
}

/// A tab that is closed and immediately re-created must get a new connection,
/// not the one that was shut down with the previous incarnation.
#[tokio::test]
async fn connection_is_not_reused_across_tab_recreation() {
    let state = Arc::new(temp_state("ssh-recreate"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));

    let first = state
        .get_or_insert_ssh_session("session-1", connector!(state, config))
        .await
        .expect("first ssh session");
    state.remove_session("session-1").expect("remove shell");
    assert!(
        first.is_closed(),
        "removal must close the cached connection"
    );

    state.put_session(shell_session("session-1"));
    let second = state
        .get_or_insert_ssh_session("session-1", connector!(state, config))
        .await
        .expect("second ssh session");
    assert!(!Arc::ptr_eq(&first, &second));
}

#[tokio::test]
async fn ssh_session_is_reused_for_the_same_shell_session() {
    let state = Arc::new(temp_state("ssh-reuse"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));

    let first = state
        .get_or_insert_ssh_session("session-1", connector!(state, config))
        .await
        .expect("first ssh session");
    let second = state
        .get_or_insert_ssh_session("session-1", || async {
            Err::<Connection, AppError>(AppError::Runtime(
                "cached session must not reconnect".to_string(),
            ))
        })
        .await
        .expect("second ssh session");

    assert!(Arc::ptr_eq(&first, &second));
}

/// A connection seeded by the PTY worker is what later operations reuse.
#[tokio::test]
async fn put_ssh_session_seeds_the_cache_for_later_operations() {
    let state = Arc::new(temp_state("ssh-put-seed"));
    let fixture = TestFixture::start(&state).await;
    state.put_session(shell_session("session-1"));

    let seeded = Arc::new(
        open_connection(&state, &fixture.config)
            .await
            .expect("seeded"),
    );
    state
        .put_ssh_session("session-1", Arc::clone(&seeded))
        .expect("seed connection");
    assert!(state.has_ssh_session("session-1"));

    let reused = state
        .get_or_insert_ssh_session("session-1", || async {
            Err::<Connection, AppError>(AppError::Runtime(
                "seeded session must not reconnect".to_string(),
            ))
        })
        .await
        .expect("seeded ssh session");
    assert!(Arc::ptr_eq(&reused, &seeded));
}

/// `put_session` must come first: seeding a connection for an unknown or
/// already-closed tab is rejected and never populates the cache.
#[tokio::test]
async fn put_ssh_session_rejects_unknown_and_closed_tabs() {
    let state = Arc::new(temp_state("ssh-put-missing"));
    let fixture = TestFixture::start(&state).await;
    let orphan = Arc::new(
        open_connection(&state, &fixture.config)
            .await
            .expect("orphan"),
    );
    assert!(matches!(
        state.put_ssh_session("session-1", Arc::clone(&orphan)),
        Err(AppError::NotFound(_))
    ));
    assert!(!state.has_ssh_session("session-1"));

    state.put_session(shell_session("session-1"));
    state.remove_session("session-1").expect("remove shell");
    let late = Arc::new(
        open_connection(&state, &fixture.config)
            .await
            .expect("late"),
    );
    assert!(matches!(
        state.put_ssh_session("session-1", late),
        Err(AppError::NotFound(_))
    ));
    assert!(!state.has_ssh_session("session-1"));
}

/// Removing a tab closes the cached connection rather than only forgetting it.
#[tokio::test]
async fn remove_session_shuts_down_cached_ssh_session() {
    let state = Arc::new(temp_state("ssh-cleanup"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));
    let cached = state
        .get_or_insert_ssh_session("session-1", connector!(state, config))
        .await
        .expect("cached ssh session");

    state.remove_session("session-1").expect("remove shell");

    assert!(cached.is_closed(), "removal must shut the connection down");
    assert!(!state.has_ssh_session("session-1"));
}

#[tokio::test]
async fn evict_ssh_session_only_drops_the_observed_connection() {
    let state = Arc::new(temp_state("ssh-evict"));
    let fixture = TestFixture::start(&state).await;
    let config = fixture.config.clone();
    state.put_session(shell_session("session-1"));

    let stale = state
        .get_or_insert_ssh_session("session-1", connector!(state, config))
        .await
        .expect("stale ssh session");

    assert!(state.evict_ssh_session("session-1", &stale));
    assert!(!state.has_ssh_session("session-1"));
    assert!(
        stale.is_closed(),
        "eviction must shut the stale connection down"
    );

    let fresh = state
        .get_or_insert_ssh_session("session-1", connector!(state, config))
        .await
        .expect("fresh ssh session");
    assert!(!Arc::ptr_eq(&stale, &fresh));

    // A late caller still holding the stale handle must not evict the fresh connection.
    assert!(!state.evict_ssh_session("session-1", &stale));
    assert!(state.has_ssh_session("session-1"));
    assert!(!fresh.is_closed());
}

#[test]
fn shell_session_token_is_created_once_across_updates() {
    let state = temp_state("session-token");
    assert!(matches!(
        state.shell_session_token("session-1"),
        Err(AppError::NotFound(_))
    ));

    state.put_session(shell_session("session-1"));
    let token = state
        .shell_session_token("session-1")
        .expect("token for live session");
    assert!(!token.is_cancelled());

    // Updates (put_session / mutate_session) must not replace the token: the
    // original handle observes a cancel applied to the freshly read one.
    state.put_session(shell_session_created_at(
        "session-1",
        "2026-09-14T09:00:00.000000000+00:00",
    ));
    state
        .mutate_session("session-1", |session| {
            session.current_dir = "/tmp".to_string();
        })
        .expect("mutate session");
    let after_updates = state.shell_session_token("session-1").expect("token");
    after_updates.cancel();
    assert!(
        token.is_cancelled(),
        "updates must keep the same token instance"
    );
}

#[test]
fn remove_session_cancels_the_shell_session_token() {
    let state = temp_state("session-token-remove");
    state.put_session(shell_session("session-1"));
    let token = state
        .shell_session_token("session-1")
        .expect("token for live session");
    assert!(!token.is_cancelled());

    state.remove_session("session-1").expect("remove session");

    assert!(token.is_cancelled(), "removal must cancel the tab token");
    assert!(matches!(
        state.shell_session_token("session-1"),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn shell_connection_cancellation_preserves_pre_cancel() {
    let state = temp_state("conn-cancel");

    let active = state.begin_shell_connection("req-1");
    assert!(!active.is_cancelled());
    assert!(!state.is_shell_connection_cancelled("req-1"));

    assert!(state.cancel_shell_connection("req-1"));
    assert!(active.is_cancelled());
    assert!(state.is_shell_connection_cancelled("req-1"));

    state.clear_shell_connection("req-1");
    assert!(!state.is_shell_connection_cancelled("req-1"));

    // Cancelling before begin leaves the returned token pre-cancelled.
    assert!(!state.cancel_shell_connection("req-2"));
    let pre = state.begin_shell_connection("req-2");
    assert!(pre.is_cancelled());
    assert!(state.is_shell_connection_cancelled("req-2"));
}

/// The SFTP plugin owns transfer cancellation now; the same pre-cancel
/// contract is asserted in `plugins::sftp::tests`.
#[test]
fn sftp_transfer_cancellation_delegates_to_the_plugin() {
    let state = temp_state("sftp-cancel");

    let plugin = &state.sftp_plugin().state;
    let active = plugin.begin_transfer("transfer-1");
    assert!(!active.is_cancelled());
    assert!(!plugin.is_transfer_cancelled("transfer-1"));

    assert!(plugin.cancel_transfer("transfer-1"));
    assert!(active.is_cancelled());
    assert!(plugin.is_transfer_cancelled("transfer-1"));

    plugin.clear_transfer("transfer-1");
    assert!(!plugin.is_transfer_cancelled("transfer-1"));

    assert!(!plugin.cancel_transfer("transfer-2"));
    let pre = plugin.begin_transfer("transfer-2");
    assert!(pre.is_cancelled());
    assert!(plugin.is_transfer_cancelled("transfer-2"));
}

#[tokio::test]
async fn pty_channels_forward_input_synchronously_and_close_on_removal() {
    let state = temp_state("pty-channel");
    state.put_session(shell_session("session-1"));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    state.put_pty_channel("session-1".to_string(), sender);

    // Synchronous send: no `.await` required on the command path.
    state
        .send_pty_command("session-1", PtyCommand::Input("ls\n".to_string()))
        .expect("send input");
    match receiver.recv().await {
        Some(PtyCommand::Input(input)) => assert_eq!(input, "ls\n"),
        other => panic!("expected forwarded input, got {other:?}"),
    }

    // Replacing the channel asks the previous worker to stop.
    let (replacement, mut replacement_rx) = tokio::sync::mpsc::unbounded_channel();
    state.put_pty_channel("session-1".to_string(), replacement);
    assert!(matches!(receiver.recv().await, Some(PtyCommand::Close)));

    assert!(matches!(
        state.send_pty_command("missing", PtyCommand::Close),
        Err(AppError::NotFound(_))
    ));

    // Removing asks the current worker to stop too.
    state.remove_pty_channel("session-1");
    assert!(matches!(
        replacement_rx.recv().await,
        Some(PtyCommand::Close)
    ));
}

/// A tab can be reopened while its previous worker is still winding down.
/// That outgoing worker must not unregister the channel its replacement just
/// registered, or the reopened PTY would be dead on arrival.
#[tokio::test]
async fn a_replaced_pty_worker_does_not_unregister_its_successor() {
    let state = temp_state("pty-generation");
    state.put_session(shell_session("session-1"));

    let (first, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
    let first_generation = state.put_pty_channel("session-1".to_string(), first);

    // The reopen: a second worker takes over the same tab.
    let (second, mut second_rx) = tokio::sync::mpsc::unbounded_channel();
    let second_generation = state.put_pty_channel("session-1".to_string(), second);
    assert_ne!(first_generation, second_generation);
    assert!(matches!(first_rx.recv().await, Some(PtyCommand::Close)));

    // The outgoing worker exits and tries to clean up after itself.
    state.remove_pty_channel_if_current("session-1", first_generation);

    // The replacement is still the live channel: input reaches it, and it was
    // never told to stop.
    state
        .send_pty_command("session-1", PtyCommand::Input("ls\n".to_string()))
        .expect("the replacement channel must survive the old worker's exit");
    assert!(matches!(
        second_rx.recv().await,
        Some(PtyCommand::Input(input)) if input == "ls\n"
    ));

    // The current worker's own cleanup does unregister it.
    state.remove_pty_channel_if_current("session-1", second_generation);
    assert!(matches!(second_rx.recv().await, Some(PtyCommand::Close)));
    assert!(matches!(
        state.send_pty_command("session-1", PtyCommand::Close),
        Err(AppError::NotFound(_))
    ));
}

/// A PTY worker seeded concurrently with tab teardown must not leave a channel
/// registered for a session that is already gone.
#[tokio::test]
async fn put_pty_channel_is_ignored_after_the_tab_is_removed() {
    let state = temp_state("pty-channel-closed");
    state.put_session(shell_session("session-1"));
    state.remove_session("session-1").expect("remove shell");

    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    state.put_pty_channel("session-1".to_string(), sender);

    // The rejected worker is told to stop so its receiver ends and it exits.
    assert!(matches!(receiver.recv().await, Some(PtyCommand::Close)));
    assert!(matches!(
        state.send_pty_command("session-1", PtyCommand::Close),
        Err(AppError::NotFound(_))
    ));
}

#[tokio::test]
async fn ki_responses_are_delivered_over_oneshot() {
    let state = temp_state("ki-pending");
    let (sender, receiver) = oneshot::channel();
    state.put_ki_pending("challenge-1", sender);

    state
        .respond_ki("challenge-1", vec!["secret".to_string()])
        .expect("respond");
    assert_eq!(
        receiver.await.expect("response"),
        vec!["secret".to_string()]
    );

    // A challenge is one-shot: responding twice is a NotFound.
    assert!(matches!(
        state.respond_ki("challenge-1", Vec::new()),
        Err(AppError::NotFound(_))
    ));
}
