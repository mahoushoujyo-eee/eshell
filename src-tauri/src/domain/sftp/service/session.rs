use std::future::Future;
use std::sync::Arc;

use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tauri::AppHandle;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::common::error::{AppError, AppResult};
use crate::common::logging::append_server_ops_debug_log;
use crate::domain::sftp::consts::*;
use crate::domain::ssh::service::session::cached_ssh_session;
use crate::domain::ssh::service::transport::CancellableStream;
use crate::state::{AppState, SharedSshSession};

/// One SFTP subsystem channel plus the physical connection that carries it.
///
/// The `Arc` keeps the physical connection alive for the whole operation even if a
/// concurrent call evicts it from the state cache, so the channel is never yanked out
/// from under an in-flight request.
pub(crate) struct SftpConnectionSession {
    _connection: SharedSshSession,
    pub(crate) session: SftpSession,
    pub(crate) cancel: CancellationToken,
    _stream_guard: DropGuard,
    _tab_watcher: TabWatcher,
}

struct TabWatcher(tokio::task::JoinHandle<()>);

impl Drop for TabWatcher {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl SftpConnectionSession {
    /// Closes the SFTP subsystem before the channel is dropped.
    ///
    /// `SftpSession::close` sends the close marker that makes russh-sftp's writer task
    /// call `shutdown()` on the underlying `ChannelStream`, which closes the SSH
    /// channel. Dropping the session is idempotent on top of that.
    pub(crate) async fn shutdown(self) {
        let _ = self.session.close().await;
    }
}

/// Awaits `future`, aborting as soon as either cancellation token fires.
///
/// `None` means "this token does not apply" and is polled as a never-completing future,
/// so the same helper serves transfer-only, session-only and combined call sites.
/// `biased` makes cancellation win ties, which keeps behaviour deterministic.
pub(crate) async fn race_cancel<T>(
    transfer_token: Option<&CancellationToken>,
    session_token: Option<&CancellationToken>,
    future: impl Future<Output = T>,
) -> Result<T, ()> {
    tokio::select! {
        biased;
        _ = wait_cancelled(transfer_token) => Err(()),
        _ = wait_cancelled(session_token) => Err(()),
        value = future => Ok(value),
    }
}

pub(crate) async fn wait_cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

pub(crate) fn transfer_cancelled_error() -> AppError {
    AppError::Runtime(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string())
}

pub(crate) fn operation_cancelled_error() -> AppError {
    AppError::Runtime(SFTP_OPERATION_CANCELLED_MESSAGE.to_string())
}

/// Opens a fresh SFTP subsystem channel on the tab's cached physical connection.
///
/// Both the transfer token and the tab token are raced around *every* acquire step
/// (connection lookup, channel open, subsystem request/reply, protocol init), so a
/// cancelled transfer or a closed tab never waits for a network round trip. A dead
/// transport surfaces here and is evicted so the next operation reconnects. A healthy
/// connection that merely rejected or stalled one SFTP request is kept: eviction is
/// driven by [`Connection::is_closed`], never by an SFTP request timeout.
pub(crate) async fn open_sftp_session(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
    transfer_token: Option<&CancellationToken>,
    session_token: Option<&CancellationToken>,
) -> AppResult<SftpConnectionSession> {
    let connection = match race_cancel(
        transfer_token,
        session_token,
        cached_ssh_session(state, app, session_id),
    )
    .await
    {
        Ok(result) => result?,
        Err(()) => return Err(acquire_cancelled_error(transfer_token)),
    };

    let mut channel = match race_cancel(
        transfer_token,
        session_token,
        connection.channel_open_session(),
    )
    .await
    {
        Ok(Ok(channel)) => channel,
        Ok(Err(error)) => {
            evict_if_stale(state, session_id, &connection);
            return Err(error);
        }
        Err(()) => return Err(acquire_cancelled_error(transfer_token)),
    };

    if let Err(error) = request_sftp_subsystem(&mut channel, transfer_token, session_token).await {
        evict_if_stale(state, session_id, &connection);
        let _ = tokio::time::timeout(SFTP_CLEANUP_TIMEOUT, channel.close()).await;
        return Err(error);
    }

    // `SftpSession::new` spawns reader/writer tasks internally. Dropping this future
    // (cancellation) drops the just-built `RawSftpSession`, whose `Drop` sends the close
    // marker that shuts the channel stream down, so the tasks cannot leak.
    let stream_cancel = connection.cancellation_token().child_token();
    let stream_guard = stream_cancel.clone().drop_guard();
    let tab_token = state.shell_session_token(session_id)?;
    let watcher_cancel = stream_cancel.clone();
    let tab_watcher = TabWatcher(tokio::spawn(async move {
        tokio::select! {
            _ = tab_token.cancelled() => watcher_cancel.cancel(),
            _ = watcher_cancel.cancelled() => {},
        }
    }));
    let stream = CancellableStream::new(channel.into_stream(), stream_cancel.clone());
    let session = match race_cancel(transfer_token, session_token, SftpSession::new(stream)).await {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => {
            let error = AppError::from(error);
            evict_if_stale(state, session_id, &connection);
            return Err(error);
        }
        Err(()) => return Err(acquire_cancelled_error(transfer_token)),
    };

    Ok(SftpConnectionSession {
        _connection: connection,
        session,
        cancel: stream_cancel,
        _stream_guard: stream_guard,
        _tab_watcher: tab_watcher,
    })
}

/// Sends the subsystem request and waits for the server's explicit Success/Failure.
///
/// Without waiting, a rejected subsystem would only surface as a timeout inside the SFTP
/// handshake. The reply wait is bounded and raced against both cancellation tokens.
async fn request_sftp_subsystem(
    channel: &mut russh::Channel<russh::client::Msg>,
    transfer_token: Option<&CancellationToken>,
    session_token: Option<&CancellationToken>,
) -> AppResult<()> {
    match race_cancel(
        transfer_token,
        session_token,
        channel.request_subsystem(true, "sftp"),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error.into()),
        Err(()) => return Err(acquire_cancelled_error(transfer_token)),
    }

    match race_cancel(
        transfer_token,
        session_token,
        tokio::time::timeout(SFTP_SUBSYSTEM_REPLY_TIMEOUT, async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::WindowAdjusted { .. }) => continue,
                    message => break message,
                }
            }
        }),
    )
    .await
    {
        Ok(Ok(Some(ChannelMsg::Success))) => Ok(()),
        Ok(Ok(Some(ChannelMsg::Failure))) => Err(AppError::Runtime(
            "server rejected the SFTP subsystem".to_string(),
        )),
        Ok(Ok(Some(_))) => Err(AppError::Runtime(
            "unexpected reply to the SFTP subsystem request".to_string(),
        )),
        Ok(Ok(None)) => Err(AppError::Runtime(
            "channel closed before the SFTP subsystem started".to_string(),
        )),
        Ok(Err(_elapsed)) => Err(AppError::Runtime(
            "timed out waiting for the SFTP subsystem".to_string(),
        )),
        Err(()) => Err(acquire_cancelled_error(transfer_token)),
    }
}

pub(crate) fn acquire_cancelled_error(transfer_token: Option<&CancellationToken>) -> AppError {
    match transfer_token {
        Some(token) if token.is_cancelled() => transfer_cancelled_error(),
        _ => operation_cancelled_error(),
    }
}

/// Evicts the observed connection only when its transport is actually closed (idle
/// timeout, sshd restart, network reset). A channel rejection or SFTP request timeout
/// on a live connection must not tear down the tab's PTY.
fn evict_if_stale(state: &AppState, session_id: &str, connection: &SharedSshSession) {
    if connection.is_closed() {
        let evicted = state.evict_ssh_session(session_id, connection);
        append_server_ops_debug_log(
            state,
            "ssh.operation_session.stale",
            session_id,
            format!("evicted={evicted}"),
        );
    }
}

/// Opens a session channel for a non-transfer operation using the tab token.
pub(crate) async fn open_operation_session(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
) -> AppResult<(SftpConnectionSession, CancellationToken)> {
    let session_token = state.shell_session_token(session_id)?;
    let handle = open_sftp_session(state, app, session_id, None, Some(&session_token)).await?;
    let operation_token = handle.cancel.clone();
    Ok((handle, operation_token))
}
