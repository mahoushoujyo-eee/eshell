//! In-process SSH server used by transport/state tests.
//!
//! The server speaks enough SSH for the transport's happy path: password authentication, session
//! channels, and `exec` (echoing the command back with exit status 0). It exists so cache
//! concurrency and stale-eviction tests can run against a real socket instead of a mock, without
//! depending on an external sshd.
//!
//! Test code must trust the server host key through `Storage::trust_ssh_host_key` using
//! [`TestSshServer::fingerprint`] / [`TestSshServer::key_type`], because the transport enforces
//! trust-on-first-use and will otherwise reject the connection.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::PrivateKey;
use russh::server::{Auth, Msg, RunningServerHandle, Server as _, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// Username accepted by [`TestSshServer`].
pub(crate) const TEST_SSH_USERNAME: &str = "eshell-test";
/// Password accepted by [`TestSshServer`].
pub(crate) const TEST_SSH_PASSWORD: &str = "eshell-test-password";

/// A throwaway ed25519 key generated solely for these tests (comment `eshell-transport-test@localhost`).
///
/// It is not a developer or production key and grants no access anywhere. If a runtime-generated
/// key is preferred later, `PrivateKey::random` plus a `rand` dev-dependency can replace this.
pub(crate) const TEST_PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBYl2htNnDN4TJ2JhVp5IdQQ4yxns/J7KduoZPVM7z31gAAAKieX/2nnl/9
pwAAAAtzc2gtZWQyNTUxOQAAACBYl2htNnDN4TJ2JhVp5IdQQ4yxns/J7KduoZPVM7z31g
AAAEBN1G93jv23csIOTUd0hNilxxJqPydS1AnWTJIMHZgjr1iXaG02cM3hMnYmFWnkh1BD
jLGez8nsp26hk9UzvPfWAAAAH2VzaGVsbC10cmFuc3BvcnQtdGVzdEBsb2NhbGhvc3QBAg
MEBQY=
-----END OPENSSH PRIVATE KEY-----
";

/// A running in-process SSH server bound to a loopback port.
pub(crate) struct TestSshServer {
    addr: SocketAddr,
    fingerprint: String,
    key_type: String,
    shutdown: RunningServerHandle,
    join: Option<JoinHandle<()>>,
}

impl TestSshServer {
    /// Binds `127.0.0.1:0` and starts serving.
    ///
    /// The listener is owned by the spawned task (not leaked), so stopping the test releases it.
    /// The task reports its bound address and shutdown handle back through a oneshot.
    pub(crate) async fn start() -> std::io::Result<Self> {
        let private_key =
            PrivateKey::from_openssh(TEST_PRIVATE_KEY).expect("parse embedded test key");
        let fingerprint = private_key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let key_type = private_key.public_key().algorithm().as_str().to_string();

        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<std::io::Result<(SocketAddr, RunningServerHandle)>>();

        let join = tokio::spawn(async move {
            let listener = match TcpListener::bind("127.0.0.1:0").await {
                Ok(listener) => listener,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let addr = match listener.local_addr() {
                Ok(addr) => addr,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };

            // The running server borrows `listener`, which lives in this task for as long as the
            // server runs, so the future stays `'static` without leaking the socket.
            let mut server = TestServer;
            let running = server.run_on_socket(
                Arc::new(russh::server::Config {
                    keys: vec![private_key],
                    ..Default::default()
                }),
                &listener,
            );
            let shutdown = running.handle();
            let _ = ready_tx.send(Ok((addr, shutdown)));
            let _ = running.await;
        });

        let (addr, shutdown) = ready_rx
            .await
            .expect("test server task dropped before reporting readiness")?;

        Ok(Self {
            addr,
            fingerprint,
            key_type,
            shutdown,
            join: Some(join),
        })
    }

    /// Loopback address the server is listening on.
    pub(crate) fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// `SHA256:...` fingerprint of the server host key.
    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// SSH algorithm name of the server host key (for `Storage::trust_ssh_host_key`).
    pub(crate) fn key_type(&self) -> &str {
        &self.key_type
    }

    /// Stops accepting connections and waits (bounded) for active sessions to finish.
    pub(crate) async fn stop(mut self) {
        self.shutdown.shutdown("test server stopping".to_string());
        if let Some(join) = self.join.take() {
            let _ = timeout(Duration::from_secs(5), join).await;
        }
    }
}

struct TestServer;

impl russh::server::Server for TestServer {
    type Handler = TestServerHandler;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        TestServerHandler
    }
}

struct TestServerHandler;

impl russh::server::Handler for TestServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == TEST_SSH_USERNAME && password == TEST_SSH_PASSWORD {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let command = String::from_utf8_lossy(data);
        session.data(channel, format!("{command}\n").into_bytes())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // No SFTP subsystem in the test server.
        session.channel_failure(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SshAuthType, SshConfig, TrustSshHostKeyInput};
    use crate::state::AppState;
    use tokio_util::sync::CancellationToken;

    /// End-to-end smoke test: start the server, trust its key, connect, and open a channel.
    #[tokio::test]
    async fn connects_to_local_server_after_trusting_host_key() {
        let server = TestSshServer::start().await.expect("start test server");
        let state = test_state("local-server");
        trust_server(&state, &server);

        let config = test_config(&server);

        let connection = super::super::connect(&state, None, &config, CancellationToken::new())
            .await
            .expect("connect");
        assert!(!connection.is_closed());
        let channel = connection
            .channel_open_session()
            .await
            .expect("open session channel");
        drop(channel);

        let generation_a = connection.generation();
        drop(connection);
        let connection = super::super::connect(&state, None, &config, CancellationToken::new())
            .await
            .expect("reconnect");
        assert!(connection.generation() > generation_a);

        server.stop().await;
    }

    /// Cancelling the connection token must actually close the transport (not merely log), even
    /// while no channel is being read.
    #[tokio::test]
    async fn shutdown_closes_transport() {
        let server = TestSshServer::start().await.expect("start test server");
        let state = test_state("shutdown");
        trust_server(&state, &server);

        let connection = super::super::connect(
            &state,
            None,
            &test_config(&server),
            CancellationToken::new(),
        )
        .await
        .expect("connect");
        assert!(!connection.is_closed());

        connection.shutdown();

        let closed = timeout(Duration::from_secs(5), async {
            while !connection.is_closed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        assert!(closed, "shutdown must close the transport");

        server.stop().await;
    }

    /// An untrusted key must surface the exact host-key-trust payload, not a generic error.
    #[tokio::test]
    async fn rejects_unknown_host_key_with_trust_payload() {
        let server = TestSshServer::start().await.expect("start test server");
        let state = test_state("unknown-host-key");

        let error = super::super::connect(
            &state,
            None,
            &test_config(&server),
            CancellationToken::new(),
        )
        .await
        .err()
        .map(|error| error.to_string())
        .expect("untrusted host key must fail");

        // `AppError::Runtime` renders as `runtime error: <message>`, so match the marker as a
        // substring rather than at the start.
        let payload = error
            .split_once(super::super::SSH_HOST_KEY_TRUST_REQUIRED_PREFIX)
            .map(|(_, payload)| payload)
            .expect("must carry the trust prefix");
        let challenge: crate::models::SshHostKeyTrustChallenge =
            serde_json::from_str(payload).expect("payload must be JSON");
        assert_eq!(challenge.host, "127.0.0.1");
        assert_eq!(challenge.fingerprint, server.fingerprint());

        server.stop().await;
    }

    fn trust_server(state: &AppState, server: &TestSshServer) {
        state
            .storage
            .trust_ssh_host_key(TrustSshHostKeyInput {
                host: "127.0.0.1".to_string(),
                port: server.addr().port(),
                key_type: server.key_type().to_string(),
                fingerprint: server.fingerprint().to_string(),
            })
            .expect("trust test host key");
    }

    fn test_config(server: &TestSshServer) -> SshConfig {
        SshConfig {
            id: "local".to_string(),
            name: "local".to_string(),
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
            created_at: crate::models::now_rfc3339(),
            updated_at: crate::models::now_rfc3339(),
        }
    }

    fn test_state(name: &str) -> Arc<AppState> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("eshell-transport-{name}-{nonce}"));
        Arc::new(AppState::new(root).expect("create app state"))
    }
}
