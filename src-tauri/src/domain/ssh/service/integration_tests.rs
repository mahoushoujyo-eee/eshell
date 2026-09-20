//! Loopback-only transport regressions; no external sshd or user credentials.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use russh::{
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use russh_sftp::protocol::{self as sftp, StatusCode};
use tokio::{net::TcpListener, sync::Notify, time::timeout};

use super::{pty, session as service, test_support, transport};
use crate::domain::sftp::service::ops::{sftp_read_file, sftp_write_file};
use crate::domain::sftp::model::*;
use crate::domain::ssh::model::*;
use crate::domain::ssh::model::session_model::*;
use crate::common::time::now_rfc3339;
use crate::state::AppState;

#[derive(Default)]
struct Counters {
    connections: AtomicUsize,
    executions: AtomicUsize,
    stalled: Notify,
    release: Notify,
    files: Mutex<HashMap<String, Vec<u8>>>,
}

struct Fixture {
    state: Arc<AppState>,
    config: SshConfig,
    counts: Arc<Counters>,
    stop: server::RunningServerHandle,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let counts = Arc::new(Counters::default());
        let key = russh::keys::PrivateKey::from_openssh(test_support::TEST_PRIVATE_KEY)
            .unwrap();
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let server_counts = counts.clone();
        let task = tokio::spawn(async move {
            let mut server = TestServer(server_counts);
            let running = server.run_on_socket(
                Arc::new(server::Config {
                    keys: vec![key],
                    auth_rejection_time: Duration::ZERO,
                    ..Default::default()
                }),
                &listener,
            );
            let _ = tx.send(running.handle());
            let _ = running.await;
        });
        let stop = rx.await.unwrap();
        let state = Arc::new(
            AppState::new(
                std::env::temp_dir()
                    .join(format!("eshell-ssh-integration-{}", uuid::Uuid::new_v4())),
            )
            .unwrap(),
        );
        state
            .storage
            .trust_ssh_host_key(TrustSshHostKeyInput {
                host: "127.0.0.1".into(),
                port: address.port(),
                key_type: "ssh-ed25519".into(),
                fingerprint,
            })
            .unwrap();
        let config = state
            .storage
            .upsert_ssh_config(SshConfigInput {
                id: None,
                name: "Loopback".into(),
                host: "127.0.0.1".into(),
                port: address.port(),
                username: "test".into(),
                auth_type: SshAuthType::Password,
                password: "test".into(),
                private_key_path: String::new(),
                private_key_passphrase: String::new(),
                use_password_fallback: false,
                jump_host_id: None,
                description: None,
            })
            .unwrap();
        state.put_session(ShellSession {
            id: "tab".into(),
            config_id: config.id.clone(),
            config_name: config.name.clone(),
            current_dir: String::new(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        });
        Self {
            state,
            config,
            counts,
            stop,
            task,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.state.remove_session("tab");
        self.stop.shutdown("test complete".into());
        self.task.abort();
    }
}

struct TestServer(Arc<Counters>);
impl server::Server for TestServer {
    type Handler = TestClient;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> TestClient {
        self.0.connections.fetch_add(1, Ordering::SeqCst);
        TestClient {
            counts: self.0.clone(),
            channels: HashMap::new(),
        }
    }
}

struct TestClient {
    counts: Arc<Counters>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}

impl server::Handler for TestClient {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if password == "test" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        _: &str,
        _: &russh::keys::PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        Ok(())
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(id)
    }
    async fn shell_request(
        &mut self,
        id: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(id)
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.counts.executions.fetch_add(1, Ordering::SeqCst);
        match command {
            b"reject" => {
                session.channel_failure(id)?;
                session.close(id)?;
            }
            b"drop" => {
                session.channel_success(id)?;
                session.close(id)?;
            }
            b"wait" => {
                session.channel_success(id)?;
                let counts = self.counts.clone();
                let handle = session.handle();
                tokio::spawn(async move {
                    counts.stalled.notify_one();
                    counts.release.notified().await;
                    let _ = handle.data(id, b"released".to_vec()).await;
                    let _ = handle.exit_status_request(id, 0).await;
                    let _ = handle.eof(id).await;
                    let _ = handle.close(id).await;
                });
            }
            _ => {
                session.channel_success(id)?;
                session.data(id, command.to_vec())?;
                session.extended_data(id, 1, b"stderr".to_vec())?;
                session.eof(id)?;
                session.exit_status_request(id, 7)?;
                session.close(id)?;
            }
        }
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            return session.channel_failure(id);
        }
        session.channel_success(id)?;
        let channel = self.channels.remove(&id).unwrap();
        russh_sftp::server::run(channel.into_stream(), TestSftp(self.counts.clone())).await;
        Ok(())
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        // Only the loopback fixture is reachable through this test jump host.
        assert_eq!(host, "127.0.0.1");
        let mut tcp = tokio::net::TcpStream::connect((host, port as u16)).await?;
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
        });
        Ok(())
    }
}

struct TestSftp(Arc<Counters>);
fn ok_status(id: u32) -> sftp::Status {
    sftp::Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
impl russh_sftp::server::Handler for TestSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn open(
        &mut self,
        id: u32,
        name: String,
        flags: sftp::OpenFlags,
        _: sftp::FileAttributes,
    ) -> Result<sftp::Handle, StatusCode> {
        let mut files = self.0.files.lock().unwrap();
        if flags.contains(sftp::OpenFlags::CREATE) {
            files.insert(name.clone(), Vec::new());
        }
        if !files.contains_key(&name) && name != "/stall" {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(sftp::Handle { id, handle: name })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<sftp::Status, StatusCode> {
        Ok(ok_status(id))
    }
    async fn read(
        &mut self,
        id: u32,
        name: String,
        offset: u64,
        len: u32,
    ) -> Result<sftp::Data, StatusCode> {
        if name == "/stall" {
            self.0.stalled.notify_one();
            self.0.release.notified().await;
            return Err(StatusCode::Eof);
        }
        let files = self.0.files.lock().unwrap();
        let data = files.get(&name).ok_or(StatusCode::NoSuchFile)?;
        let start = offset as usize;
        if start >= data.len() {
            return Err(StatusCode::Eof);
        }
        Ok(sftp::Data {
            id,
            data: data[start..(start + len as usize).min(data.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        name: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<sftp::Status, StatusCode> {
        let mut files = self.0.files.lock().unwrap();
        let file = files.get_mut(&name).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        file.resize(file.len().max(offset + data.len()), 0);
        file[offset..offset + data.len()].copy_from_slice(&data);
        Ok(ok_status(id))
    }
    async fn rename(
        &mut self,
        id: u32,
        from: String,
        to: String,
    ) -> Result<sftp::Status, StatusCode> {
        let mut files = self.0.files.lock().unwrap();
        let data = files.remove(&from).ok_or(StatusCode::NoSuchFile)?;
        files.insert(to, data);
        Ok(ok_status(id))
    }
}

#[tokio::test]
async fn pty_and_concurrent_exec_reuse_one_physical_connection() {
    timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let connection = service::cached_ssh_session(&fixture.state, None, "tab")
            .await
            .unwrap();
        let _pty = pty::open_channel(&connection).await.unwrap();
        let slow_state = fixture.state.clone();
        let slow =
            tokio::spawn(async move { service::execute_command(&slow_state, "tab", "wait").await });
        fixture.counts.stalled.notified().await;
        let fast = service::execute_command(&fixture.state, "tab", "fast")
            .await
            .unwrap();
        assert_eq!(fast.stdout, "fast");
        assert_eq!(fast.stderr, "stderr");
        assert_eq!(fast.exit_code, 7);
        assert!(!slow.is_finished());
        fixture.counts.release.notify_one();
        assert_eq!(slow.await.unwrap().unwrap().stdout, "released");
        assert_eq!(fixture.counts.connections.load(Ordering::SeqCst), 1);
    })
    .await
    .expect("multiplexing timed out");
}

#[tokio::test]
async fn exec_is_never_replayed_after_request_dispatch() {
    timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        for command in ["reject", "drop"] {
            assert!(service::execute_command(&fixture.state, "tab", command)
                .await
                .is_err());
        }
        assert_eq!(fixture.counts.executions.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.counts.connections.load(Ordering::SeqCst), 1);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn stale_channel_open_reconnects_before_executing_once() {
    timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let connection = service::cached_ssh_session(&fixture.state, None, "tab")
            .await
            .unwrap();
        connection.shutdown();
        let result = service::execute_command(&fixture.state, "tab", "once")
            .await
            .unwrap();
        assert_eq!(result.stdout, "once");
        assert_eq!(fixture.counts.executions.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.counts.connections.load(Ordering::SeqCst), 2);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn sftp_roundtrip_and_stalled_read_do_not_block_exec() {
    timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let text = "中abc".repeat(100_000);
        sftp_write_file(
            &fixture.state,
            None,
            SftpWriteInput {
                session_id: "tab".into(),
                path: "/test".into(),
                content: text.clone(),
            },
        )
        .await
        .unwrap();
        let read = sftp_read_file(
            &fixture.state,
            None,
            SftpReadInput {
                session_id: "tab".into(),
                path: "/test".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(read.content, text);
        let state = fixture.state.clone();
        let stalled = tokio::spawn(async move {
            sftp_read_file(
                &state,
                None,
                SftpReadInput {
                    session_id: "tab".into(),
                    path: "/stall".into(),
                },
            )
            .await
        });
        fixture.counts.stalled.notified().await;
        assert_eq!(
            service::execute_command(&fixture.state, "tab", "fast")
                .await
                .unwrap()
                .stdout,
            "fast"
        );
        assert_eq!(fixture.counts.connections.load(Ordering::SeqCst), 1);
        fixture.state.remove_session("tab").unwrap();
        assert!(timeout(Duration::from_secs(3), stalled)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        fixture.counts.release.notify_one();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn private_key_auth_and_bad_key_password_fallback() {
    timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let key_path = fixture.state.storage.data_dir().join("test-key");
        tokio::fs::write(&key_path, test_support::TEST_PRIVATE_KEY)
            .await
            .unwrap();
        let mut config = fixture.config.clone();
        config.auth_type = SshAuthType::PrivateKey;
        config.private_key_path = key_path.to_string_lossy().into_owned();
        let connection = transport::connect(&fixture.state, None, &config, Default::default())
            .await
            .unwrap();
        assert!(!connection.is_closed());
        connection.shutdown();
        tokio::fs::write(&key_path, "invalid test key")
            .await
            .unwrap();
        config.use_password_fallback = true;
        let connection = transport::connect(&fixture.state, None, &config, Default::default())
            .await
            .unwrap();
        assert!(!connection.is_closed());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn jump_channel_carries_nested_handshake_and_exec() {
    timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let mut target = fixture.config.clone();
        target.id = "target".into();
        target.jump_host_id = Some(fixture.config.id.clone());
        let connection = transport::connect(&fixture.state, None, &target, Default::default())
            .await
            .unwrap();
        let mut channel = connection.channel_open_session().await.unwrap();
        channel.exec(true, b"through-jump".to_vec()).await.unwrap();
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => output.extend_from_slice(&data),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        assert_eq!(output, b"through-jump");
        assert_eq!(fixture.counts.connections.load(Ordering::SeqCst), 2);
    })
    .await
    .unwrap();
}
