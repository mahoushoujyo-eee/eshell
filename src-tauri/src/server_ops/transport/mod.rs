//! Async SSH transport built on `russh`, replacing the blocking libssh2/`ssh2` stack.
//!
//! [`connect`] performs TCP (or jump-host) connection, host-key trust-on-first-use, and
//! authentication, and returns an authenticated [`Connection`]. After authentication the russh
//! `Handle` is shared immutably behind an `Arc`: opening channels never takes a whole-session lock,
//! so a slow SFTP transfer cannot stall command execution or the PTY on the same tab.
//!
//! Liveness is explicit: keepalives are configured on the russh `Config`, and when the session
//! actually ends the handler cancels the connection token. There is no idle GC and no automatic
//! reconnect; eviction is the cache holder's decision, based on [`Connection::is_closed`] and
//! [`is_stale_connection_error`].

mod error;
mod handler;

#[cfg(test)]
pub(crate) mod test_support;

use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use russh::client::{AuthResult, Config, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{client, Channel};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{SshAuthType, SshConfig, SshKiPromptEvent, SshKiPromptItem};
use crate::state::AppState;

use error::TransportError;
use handler::ConnectionHandler;

pub use error::is_stale_connection_error;

/// Shared, immutable-after-auth connection handle as cached by the application state.
pub type SharedConnection = Arc<Connection>;

/// Prefix of the runtime error payload the frontend matches to open a host-key trust prompt.
pub const SSH_HOST_KEY_TRUST_REQUIRED_PREFIX: &str = "SSH_HOST_KEY_TRUST_REQUIRED:";
/// Tauri event used to ask the user for keyboard-interactive answers.
pub const SSH_KI_PROMPT_EVENT: &str = "ssh-ki-prompt";

const SSH_CONNECTION_CANCELLED_MESSAGE: &str = "SSH connection cancelled by user";
const SSH_CONNECT_TOTAL_TIMEOUT: Duration = Duration::from_secs(45);
const SSH_CONNECT_SLICE_TIMEOUT: Duration = Duration::from_millis(500);
const SSH_CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_KI_TIMEOUT: Duration = Duration::from_secs(300);
const SSH_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Interval at which russh sends keepalives. Without these a silently dropped connection is never
/// detected. This is keepalive, not idle GC: the connection is only closed after
/// [`SSH_KEEPALIVE_MAX`] unanswered probes.
const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
const SSH_KEEPALIVE_MAX: usize = 3;
/// Maximum number of configs in a jump chain, including the target itself.
const MAX_JUMP_DEPTH: usize = 4;

static CONNECTION_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Connects, verifies the host key, and authenticates a server from its stored config.
///
/// `cancel` is observed at every stage (DNS, per-address TCP attempt, handshake, auth,
/// keyboard-interactive wait) and is never cancelled by the returned connection. The connection
/// derives its own token via `child_token`, so evicting or dropping it does not tear down the tab.
pub async fn connect(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    config: &SshConfig,
    cancel: CancellationToken,
) -> AppResult<Connection> {
    let mut visited = Vec::new();
    connect_inner(state, app, config, cancel, 0, &mut visited).await
}

async fn connect_inner(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    config: &SshConfig,
    cancel: CancellationToken,
    depth: usize,
    visited: &mut Vec<String>,
) -> AppResult<Connection> {
    validate_jump_chain(depth, visited, &config.id)?;
    visited.push(config.id.clone());

    if cancel.is_cancelled() {
        return Err(connection_cancelled_error());
    }

    // The connection's own token is a child: cancelling it on eviction/drop must not cancel the
    // caller's tab token, and cancelling the tab token still tears this connection down.
    let connection_cancel = cancel.child_token();
    // If anything from here on returns early (auth failure, timeout) or the caller drops the
    // connect future, this guard cancels the token, which makes `CancellableStream` error out and
    // closes the raw TCP socket / jump channel. Disarmed only once the Connection is built.
    let connection_guard = connection_cancel.clone().drop_guard();

    // A jump host is itself a full connection, recursively resolved. The jump connection is kept
    // alive for the lifetime of the target connection.
    let jump = match config.jump_host_id.as_deref().filter(|id| !id.is_empty()) {
        Some(jump_id) => {
            let jump_config = state
                .storage
                .find_ssh_config(jump_id)
                .map_err(|_| AppError::Runtime(format!("jump host config {jump_id} not found")))?;
            let jump_cancel = cancel.child_token();
            let jump = Box::pin(connect_inner(
                state,
                app,
                &jump_config,
                jump_cancel,
                depth + 1,
                visited,
            ))
            .await?;
            Some(Arc::new(jump))
        }
        None => None,
    };

    let endpoint = endpoint_of(config);
    let handler = ConnectionHandler::new(
        state,
        config.host.clone(),
        config.port,
        connection_cancel.clone(),
    );
    let client_config = client_config();

    let handle = if let Some(jump) = jump.as_ref() {
        let channel = run_stage(
            &cancel,
            SSH_HANDSHAKE_TIMEOUT,
            jump.handle.channel_open_direct_tcpip(
                config.host.clone(),
                u32::from(config.port),
                "127.0.0.1",
                0,
            ),
            || AppError::Runtime(format!("opening jump channel to {endpoint} timed out")),
        )
        .await?
        .map_err(|error| {
            AppError::Runtime(format!(
                "failed to open jump channel to {}:{}: {error}",
                config.host, config.port
            ))
        })?;

        let stream = CancellableStream::new(channel.into_stream(), connection_cancel.clone());
        run_stage(
            &cancel,
            SSH_HANDSHAKE_TIMEOUT,
            client::connect_stream(client_config, stream, handler),
            || AppError::Runtime(format!("SSH handshake timed out for {endpoint}")),
        )
        .await?
        .map_err(|error| transport_error_to_app(error, &endpoint))?
    } else {
        let stream = CancellableStream::new(
            connect_tcp(config, &cancel).await?,
            connection_cancel.clone(),
        );
        run_stage(
            &cancel,
            SSH_HANDSHAKE_TIMEOUT,
            client::connect_stream(client_config, stream, handler),
            || AppError::Runtime(format!("SSH handshake timed out for {endpoint}")),
        )
        .await?
        .map_err(|error| transport_error_to_app(error, &endpoint))?
    };

    let mut handle = handle;
    authenticate(state, app, config, &mut handle, &cancel).await?;

    if handle.is_closed() {
        return Err(AppError::Runtime(format!(
            "SSH connection to {endpoint} closed during authentication"
        )));
    }

    connection_guard.disarm();

    Ok(Connection {
        id: Uuid::new_v4().to_string(),
        generation: CONNECTION_GENERATION.fetch_add(1, Ordering::Relaxed),
        handle: Arc::new(handle),
        cancel: connection_cancel,
        jump,
        endpoint,
        config_id: config.id.clone(),
    })
}

/// Rejects jump chains that exceed the configured depth or loop back on themselves.
///
/// The chain is resolved before any socket is opened, so a misconfigured cycle fails fast instead
/// of recursing until the process runs out of stack/connections.
fn validate_jump_chain(depth: usize, visited: &[String], config_id: &str) -> AppResult<()> {
    if depth >= MAX_JUMP_DEPTH {
        return Err(AppError::Validation(format!(
            "jump host chain exceeds the maximum depth of {MAX_JUMP_DEPTH}"
        )));
    }
    if visited.iter().any(|id| id == config_id) {
        return Err(AppError::Validation(format!(
            "jump host cycle detected at config {config_id}"
        )));
    }
    Ok(())
}

/// An authenticated SSH connection.
///
/// The russh handle is shared immutably; every operation takes `&self`. Dropping the connection (or
/// calling [`Connection::shutdown`]) cancels its token; the jump chain is dropped with it.
pub struct Connection {
    id: String,
    generation: u64,
    handle: Arc<Handle<ConnectionHandler>>,
    cancel: CancellationToken,
    jump: Option<Arc<Connection>>,
    endpoint: String,
    config_id: String,
}

impl Connection {
    /// Unique id of this connection instance.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Monotonic generation, bumped for every connection the process opens.
    ///
    /// Cache holders use it to tell a replaced connection apart from the one they observed.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// `user@host:port` as configured, for error messages and logs.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Id of the [`SshConfig`] this connection was opened from.
    pub fn config_id(&self) -> &str {
        &self.config_id
    }

    /// Whether the underlying transport has already closed.
    pub fn is_closed(&self) -> bool {
        self.cancel.is_cancelled() || self.handle.is_closed()
    }

    /// Token cancelled when this connection is shut down, closed, or the session ends.
    ///
    /// Long-running operations should `select!` on `token.cancelled()` so a tab teardown or a dead
    /// transport interrupts an in-flight read instead of waiting for the peer to time out.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Opens a new session channel on this connection, bounded by timeout and cancellation.
    pub async fn channel_open_session(&self) -> AppResult<Channel<client::Msg>> {
        run_stage(
            &self.cancel,
            SSH_CHANNEL_OPEN_TIMEOUT,
            self.handle.channel_open_session(),
            || AppError::Runtime("opening SSH session channel timed out".to_string()),
        )
        .await?
        .map_err(AppError::from)
    }

    /// Opens a `direct-tcpip` channel, used to reach a target through a jump host.
    pub async fn channel_open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
        originator_address: &str,
        originator_port: u16,
    ) -> AppResult<Channel<client::Msg>> {
        run_stage(
            &self.cancel,
            SSH_CHANNEL_OPEN_TIMEOUT,
            self.handle.channel_open_direct_tcpip(
                host.to_string(),
                u32::from(port),
                originator_address.to_string(),
                u32::from(originator_port),
            ),
            || {
                AppError::Runtime(format!(
                    "opening SSH direct-tcpip channel to {host}:{port} timed out"
                ))
            },
        )
        .await?
        .map_err(AppError::from)
    }

    /// The jump connection this one was tunnelled through, if any.
    pub fn jump_connection(&self) -> Option<&Arc<Connection>> {
        self.jump.as_ref()
    }

    /// Synchronous teardown: cancels the connection token and starts a graceful disconnect.
    ///
    /// Safe to call from any context. The disconnect is best-effort: without a running tokio runtime
    /// the transport still closes when the handle is dropped.
    pub fn shutdown(&self) {
        self.cancel.cancel();
        spawn_graceful_disconnect(Arc::clone(&self.handle));
    }

    /// Awaitable graceful disconnect for callers that can yield.
    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "client shutdown", "")
            .await;
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Cancel the connection's own (child) token so waiters stop, but never the caller's tab
        // token. Dropping the last `Arc<Handle>` then drops the session's message sender; russh's
        // session loop observes the closed receiver and exits, closing the transport. No spawned
        // disconnect here: `Drop` can run while the runtime is shutting down, where `spawn` may
        // panic. Explicit `shutdown()` performs the graceful disconnect instead.
        self.cancel.cancel();
    }
}

fn spawn_graceful_disconnect(handle: Arc<Handle<ConnectionHandler>>) {
    if handle.is_closed() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    runtime.spawn(async move {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "client shutdown", "")
            .await;
    });
}

/// Wraps the raw TCP socket or jump `direct-tcpip` channel so cancellation actually closes it.
///
/// russh's `Handle::drop` only logs, and an open channel keeps a message sender alive, so a
/// cancelled or dropped connection could otherwise leave the underlying socket open until the peer
/// timed out. Reporting an IO error from the stream the moment the token is cancelled makes the
/// session loop terminate promptly, which closes both the TCP socket and the jump channel.
pub(super) struct CancellableStream<S> {
    inner: S,
    read_cancelled: Pin<Box<dyn Future<Output = ()> + Send + Sync>>,
    write_cancelled: Pin<Box<dyn Future<Output = ()> + Send + Sync>>,
}

impl<S> CancellableStream<S> {
    pub(super) fn new(inner: S, cancel: CancellationToken) -> Self {
        // Split readers and writers can have different task wakers.
        Self {
            inner,
            read_cancelled: Box::pin(cancel.clone().cancelled_owned()),
            write_cancelled: Box::pin(cancel.cancelled_owned()),
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for CancellableStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.read_cancelled.as_mut().poll(cx).is_ready() {
            // EOF terminates both russh and russh-sftp readers. A persistent IO
            // error makes russh-sftp's reader log/retry in a tight loop instead.
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for CancellableStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.write_cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(connection_cancelled_io_error()));
        }
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.write_cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(connection_cancelled_io_error()));
        }
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

fn connection_cancelled_io_error() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, SSH_CONNECTION_CANCELLED_MESSAGE)
}

fn client_config() -> Arc<Config> {
    let mut config = Config::default();
    // Keepalive is required: without it a silently dropped connection (NAT/firewall idle timeout,
    // sshd restart) is never noticed and reads hang forever. This is not idle GC: the transport is
    // closed only after SSH_KEEPALIVE_MAX unanswered probes, and there is no inactivity timeout.
    config.keepalive_interval = Some(SSH_KEEPALIVE_INTERVAL);
    config.keepalive_max = SSH_KEEPALIVE_MAX;
    config.inactivity_timeout = None;
    config.nodelay = true;
    Arc::new(config)
}

async fn authenticate(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    config: &SshConfig,
    handle: &mut Handle<ConnectionHandler>,
    cancel: &CancellationToken,
) -> AppResult<()> {
    match config.auth_type {
        SshAuthType::Password => {
            let password_result = authenticate_with_password(config, handle, cancel).await;
            let password_error = match password_result {
                Ok(()) => return Ok(()),
                Err(error) => error,
            };
            // Many PAM setups reject the "password" method and only offer keyboard-interactive.
            // A dead transport or a cancelled connect must not trigger an interactive prompt, and
            // with no interactive UI the original password failure is kept.
            if cancel.is_cancelled() || is_stale_connection_error(&password_error) {
                return Err(password_error);
            }
            match app {
                Some(app) => {
                    match authenticate_keyboard_interactive(state, app, config, handle, cancel)
                        .await
                    {
                        Ok(()) => Ok(()),
                        Err(_) => Err(password_error),
                    }
                }
                None => Err(password_error),
            }
        }
        SshAuthType::PrivateKey => authenticate_with_private_key(config, handle, cancel).await,
        SshAuthType::KeyboardInteractive => {
            let app = app.ok_or_else(|| {
                AppError::Runtime("keyboard-interactive auth requires an app handle".to_string())
            })?;
            authenticate_keyboard_interactive(state, app, config, handle, cancel).await
        }
    }
}

async fn authenticate_with_password(
    config: &SshConfig,
    handle: &mut Handle<ConnectionHandler>,
    cancel: &CancellationToken,
) -> AppResult<()> {
    if config.password.is_empty() {
        return Err(AppError::Validation(
            "password cannot be empty for password authentication".to_string(),
        ));
    }

    let result = run_stage(
        cancel,
        SSH_AUTH_TIMEOUT,
        handle.authenticate_password(config.username.clone(), config.password.clone()),
        || {
            AppError::Runtime(format!(
                "SSH authentication timed out for {}",
                endpoint_of(config)
            ))
        },
    )
    .await??;
    finish_password_auth(result, config)
}

async fn authenticate_with_private_key(
    config: &SshConfig,
    handle: &mut Handle<ConnectionHandler>,
    cancel: &CancellationToken,
) -> AppResult<()> {
    let key_path = config.private_key_path.trim();
    if key_path.is_empty() {
        return Err(AppError::Validation(
            "private key path cannot be empty for private key authentication".to_string(),
        ));
    }
    if !Path::new(key_path).exists() {
        return Err(AppError::Validation(format!(
            "private key file does not exist: {key_path}"
        )));
    }

    // Decrypting a key is blocking file IO + KDF work; keep it off the async runtime.
    let key_path_owned = key_path.to_string();
    let passphrase = if config.private_key_passphrase.is_empty() {
        None
    } else {
        Some(config.private_key_passphrase.clone())
    };
    let load = tokio::task::spawn_blocking(move || {
        load_secret_key(&key_path_owned, passphrase.as_deref())
    });

    let key = match run_stage(cancel, SSH_AUTH_TIMEOUT, load, || {
        AppError::Runtime(format!(
            "SSH authentication timed out for {}",
            endpoint_of(config)
        ))
    })
    .await
    {
        Ok(Ok(Ok(key))) => key,
        Ok(Ok(Err(error))) => {
            return password_fallback_or_key_error(
                config,
                handle,
                cancel,
                AppError::from(russh::Error::Keys(error)),
            )
            .await;
        }
        Ok(Err(join_error)) => {
            return password_fallback_or_key_error(
                config,
                handle,
                cancel,
                AppError::Runtime(format!("private key load task failed: {join_error}")),
            )
            .await;
        }
        Err(error) => return Err(error),
    };

    // RSA servers advertise their best accepted signature hash; pass it so modern sshd does not
    // reject the legacy SHA-1 `ssh-rsa` signature.
    let hash_alg = run_stage(
        cancel,
        SSH_AUTH_TIMEOUT,
        handle.best_supported_rsa_hash(),
        || AppError::Runtime("SSH signature algorithm negotiation timed out".to_string()),
    )
    .await??
    .flatten();
    let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);

    let key_result = run_stage(
        cancel,
        SSH_AUTH_TIMEOUT,
        handle.authenticate_publickey(config.username.clone(), key_with_hash),
        || {
            AppError::Runtime(format!(
                "SSH authentication timed out for {}",
                endpoint_of(config)
            ))
        },
    )
    .await;

    let key_error = match key_result {
        Ok(Ok(AuthResult::Success)) => return Ok(()),
        Ok(Ok(AuthResult::Failure { .. })) => {
            AppError::Runtime(format!("authentication failed for {}", endpoint_of(config)))
        }
        Ok(Err(error)) => AppError::from(error),
        Err(error) => error,
    };

    password_fallback_or_key_error(config, handle, cancel, key_error).await
}

/// Uses the configured password fallback when present, otherwise reports the key failure.
///
/// This also covers a private key that cannot be parsed or decrypted: a server that accepts the
/// configured password should still let the user in, exactly as if the signature had been refused.
async fn password_fallback_or_key_error(
    config: &SshConfig,
    handle: &mut Handle<ConnectionHandler>,
    cancel: &CancellationToken,
    key_error: AppError,
) -> AppResult<()> {
    if config.use_password_fallback && !config.password.is_empty() {
        return authenticate_with_password(config, handle, cancel)
            .await
            .map_err(|fallback_error| map_key_auth_error(config, fallback_error));
    }
    Err(map_key_auth_error(config, key_error))
}

async fn authenticate_keyboard_interactive(
    state: &Arc<AppState>,
    app: &AppHandle,
    config: &SshConfig,
    handle: &mut Handle<ConnectionHandler>,
    cancel: &CancellationToken,
) -> AppResult<()> {
    let request_id = Uuid::new_v4().to_string();

    let mut response = match run_stage(
        cancel,
        SSH_KI_TIMEOUT,
        handle.authenticate_keyboard_interactive_start(config.username.clone(), None::<String>),
        || {
            AppError::Runtime(format!(
                "SSH authentication timed out for {}",
                endpoint_of(config)
            ))
        },
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(AppError::from(error)),
        Err(error) => return Err(error),
    };

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(AppError::Runtime(format!(
                    "keyboard-interactive authentication failed for {}",
                    endpoint_of(config)
                )));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                instructions,
                prompts,
                ..
            } => {
                let answers = prompt_frontend(
                    state,
                    app,
                    &request_id,
                    &config.username,
                    &instructions,
                    &prompts,
                    cancel,
                )
                .await?;

                response = match run_stage(
                    cancel,
                    SSH_KI_TIMEOUT,
                    handle.authenticate_keyboard_interactive_respond(answers),
                    || {
                        AppError::Runtime(format!(
                            "SSH authentication timed out for {}",
                            endpoint_of(config)
                        ))
                    },
                )
                .await
                {
                    Ok(Ok(response)) => response,
                    Ok(Err(error)) => return Err(AppError::from(error)),
                    Err(error) => return Err(error),
                };
            }
        }
    }
}

/// Clears a pending keyboard-interactive entry when the awaiting future is dropped.
///
/// Without this, cancelling the connect future mid-prompt would leave the request id registered
/// forever, and a later `respond_ki` would deliver into a dead channel.
struct KiPendingGuard<'a> {
    state: &'a AppState,
    request_id: &'a str,
}

impl Drop for KiPendingGuard<'_> {
    fn drop(&mut self) {
        self.state.clear_ki_pending(self.request_id);
    }
}

/// Asks the frontend for keyboard-interactive answers and waits for `respond_ki`.
async fn prompt_frontend(
    state: &Arc<AppState>,
    app: &AppHandle,
    request_id: &str,
    username: &str,
    instructions: &str,
    prompts: &[client::Prompt],
    cancel: &CancellationToken,
) -> AppResult<Vec<String>> {
    let prompt_count = prompts.len();
    if prompt_count == 0 {
        return Ok(Vec::new());
    }

    let (sender, receiver) = tokio::sync::oneshot::channel::<Vec<String>>();
    state.put_ki_pending(request_id, sender);
    let _pending_guard = KiPendingGuard {
        state: state.as_ref(),
        request_id,
    };

    let event = SshKiPromptEvent {
        request_id: request_id.to_string(),
        username: username.to_string(),
        instructions: instructions.to_string(),
        prompts: prompts
            .iter()
            .map(|prompt| SshKiPromptItem {
                text: prompt.prompt.clone(),
                echo: prompt.echo,
            })
            .collect(),
    };

    if app.emit(SSH_KI_PROMPT_EVENT, &event).is_err() {
        return Ok(vec![String::new(); prompt_count]);
    }

    let outcome = tokio::select! {
        _ = cancel.cancelled() => return Err(connection_cancelled_error()),
        outcome = timeout(SSH_KI_TIMEOUT, receiver) => outcome,
    };

    match outcome {
        Ok(Ok(mut responses)) => {
            if responses.len() != prompt_count {
                responses.resize(prompt_count, String::new());
            }
            Ok(responses)
        }
        // Timeout or a dropped sender: answer empty so the server rejects the attempt rather than
        // leaving the auth exchange hung.
        _ => Ok(vec![String::new(); prompt_count]),
    }
}

fn finish_password_auth(result: AuthResult, config: &SshConfig) -> AppResult<()> {
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(AppError::Runtime(format!(
            "authentication failed for {}",
            endpoint_of(config)
        ))),
    }
}

fn map_key_auth_error(config: &SshConfig, error: AppError) -> AppError {
    AppError::Runtime(format!(
        "private key authentication failed for {}: {error}. Check the private key path and passphrase.",
        endpoint_of(config)
    ))
}

fn transport_error_to_app(error: TransportError, endpoint: &str) -> AppError {
    match error {
        TransportError::HostKeyTrustRequired(challenge) => {
            error::host_key_trust_required(challenge)
        }
        TransportError::Russh(error) => error::map_russh_connect_error(error, endpoint),
    }
}

/// Runs `future` under a deadline while staying cancellable, without consuming the cancel token.
async fn run_stage<F, T>(
    cancel: &CancellationToken,
    duration: Duration,
    future: F,
    on_timeout: impl FnOnce() -> AppError,
) -> AppResult<T>
where
    F: Future<Output = T>,
{
    let outcome = tokio::select! {
        _ = cancel.cancelled() => return Err(connection_cancelled_error()),
        outcome = timeout(duration, future) => outcome,
    };
    outcome.map_err(|_| on_timeout())
}

async fn connect_tcp(config: &SshConfig, cancel: &CancellationToken) -> AppResult<TcpStream> {
    // Resolution can block for seconds on a bad resolver; make it cancellable rather than checking
    // a flag before/after.
    let lookup = run_stage(
        cancel,
        SSH_CONNECT_TOTAL_TIMEOUT,
        tokio::net::lookup_host((config.host.as_str(), config.port)),
        || {
            AppError::Runtime(format!(
                "SSH address resolution timed out for {}",
                config.host
            ))
        },
    )
    .await?;
    let addresses = lookup.map_err(AppError::Io)?.collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(AppError::Runtime(format!(
            "no socket addresses resolved for {}:{}",
            config.host, config.port
        )));
    }

    let started_at = Instant::now();
    let mut last_error: Option<std::io::Error> = None;
    while started_at.elapsed() < SSH_CONNECT_TOTAL_TIMEOUT {
        for address in &addresses {
            let remaining = SSH_CONNECT_TOTAL_TIMEOUT.saturating_sub(started_at.elapsed());
            if remaining.is_zero() {
                break;
            }
            let slice = remaining.min(SSH_CONNECT_SLICE_TIMEOUT);
            let outcome = tokio::select! {
                _ = cancel.cancelled() => return Err(connection_cancelled_error()),
                outcome = timeout(slice, TcpStream::connect(address)) => outcome,
            };
            match outcome {
                Ok(Ok(stream)) => {
                    let _ = stream.set_nodelay(true);
                    return Ok(stream);
                }
                Ok(Err(error)) if is_retryable_connect_error(&error) => last_error = Some(error),
                Ok(Err(error)) => return Err(AppError::Io(error)),
                Err(_) => {
                    last_error = Some(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("connection attempt to {address} timed out"),
                    ))
                }
            }
        }

        tokio::select! {
            _ = cancel.cancelled() => return Err(connection_cancelled_error()),
            _ = tokio::time::sleep(SSH_CONNECT_POLL_INTERVAL) => {}
        }
    }

    Err(AppError::Io(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "connection attempt timed out for {}:{}",
                config.host, config.port
            ),
        )
    })))
}

fn is_retryable_connect_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::Interrupted
    )
}

fn connection_cancelled_error() -> AppError {
    AppError::Runtime(SSH_CONNECTION_CANCELLED_MESSAGE.to_string())
}

fn endpoint_of(config: &SshConfig) -> String {
    format!("{}@{}:{}", config.username, config.host, config.port)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            created_at: crate::models::now_rfc3339(),
            updated_at: crate::models::now_rfc3339(),
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
}
