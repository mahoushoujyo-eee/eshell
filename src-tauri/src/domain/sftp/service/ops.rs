//! Async SFTP operations over the shared per-tab russh connection.
//!
//! This module is the SFTP extension's implementation. It moved from
//! `server_ops/sftp.rs` unchanged in behavior; the differences are
//! plugin-scoped: every public operation checks the extension is active
//! (and is leased busy) before touching the wire, and the transfer
//! cancellation registry lives on the plugin state.
//!
//! Every high-level operation opens its own SFTP *session channel* on the single
//! physical `Connection` cached for the shell tab. The physical connection is never
//! locked or held for the duration of a transfer: opening a subsystem channel per
//! operation is cheap, and it means a slow upload can never block a directory listing
//! (or the status poll) on the same tab.
//!
//! Cancellation is token based. A per-transfer [`CancellationToken`] comes from
//! `AppState::begin_sftp_transfer`, and the tab-scoped token from
//! `AppState::shell_session_token` fires when the shell session is closed. Network
//! waits race both tokens with `tokio::select!`, so cancellation is observed while a
//! request is in flight rather than only at the next loop iteration. Every terminal
//! path closes its remote file handles before the channel shuts down.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh::ChannelMsg;
use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::{CancellationToken, DropGuard};
use uuid::Uuid;

use crate::common::error::{AppError, AppResult};
use crate::domain::sftp::model::{
    SftpCreateInput, SftpDeleteInput, SftpDownloadInput, SftpDownloadPayload,
    SftpDownloadToLocalInput, SftpEntry, SftpEntryType, SftpFileContent, SftpListInput,
    SftpListResponse, SftpReadInput, SftpRenameInput, SftpTransferEvent, SftpTransferResult,
    SftpUploadInput, SftpUploadLocalWithProgressInput, SftpUploadWithProgressInput, SftpWriteInput,
};
use crate::common::logging::append_server_ops_debug_log;
use crate::domain::ssh::service::session::cached_ssh_session;
use crate::state::{AppState, SharedSshSession};
use crate::domain::sftp::consts::*;

// Re-exported so the `ops::SFTP_*_CANCELLED_MESSAGE` paths used by the tests
// moved to `domain/sftp/tests.rs` keep resolving.
pub(crate) use crate::domain::sftp::consts::{
    SFTP_OPERATION_CANCELLED_MESSAGE, SFTP_TRANSFER_CANCELLED_MESSAGE,
};

/// One SFTP subsystem channel plus the physical connection that carries it.
///
/// The `Arc` keeps the physical connection alive for the whole operation even if a
/// concurrent call evicts it from the state cache, so the channel is never yanked out
/// from under an in-flight request.
struct SftpConnectionSession {
    _connection: SharedSshSession,
    session: SftpSession,
    cancel: CancellationToken,
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
    async fn shutdown(self) {
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

async fn wait_cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

fn transfer_cancelled_error() -> AppError {
    AppError::Runtime(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string())
}

fn operation_cancelled_error() -> AppError {
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
async fn open_sftp_session(
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
    let stream = crate::domain::ssh::service::transport::CancellableStream::new(
        channel.into_stream(),
        stream_cancel.clone(),
    );
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

fn acquire_cancelled_error(transfer_token: Option<&CancellationToken>) -> AppError {
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
async fn open_operation_session(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
) -> AppResult<(SftpConnectionSession, CancellationToken)> {
    let session_token = state.shell_session_token(session_id)?;
    let handle = open_sftp_session(state, app, session_id, None, Some(&session_token)).await?;
    let operation_token = handle.cancel.clone();
    Ok((handle, operation_token))
}

/// Lists directory entries through SFTP.
pub async fn sftp_list_dir(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpListInput,
) -> AppResult<SftpListResponse> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = list_remote_dir(&handle.session, &token, &input.path).await;
    handle.shutdown().await;
    result
}

async fn list_remote_dir(
    session: &SftpSession,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<SftpListResponse> {
    let requested_path = normalize_remote_path(path);
    let read_dir = match race_cancel(
        None,
        Some(session_token),
        session.read_dir(requested_path.as_str()),
    )
    .await
    {
        Ok(result) => result?,
        Err(()) => return Err(operation_cancelled_error()),
    };

    let mut entries = read_dir
        .filter(|entry| !matches!(entry.file_name().as_str(), "." | ".."))
        .map(|entry| {
            let name = entry.file_name();
            let attrs = entry.metadata();
            SftpEntry {
                path: join_remote_path(&requested_path, &name),
                entry_type: entry_type_from_file_type(attrs.file_type()),
                size: attrs.size.unwrap_or_default(),
                modified_at: attrs.mtime.map(u64::from),
                name,
            }
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        let left_is_dir = left.entry_type == SftpEntryType::Directory;
        let right_is_dir = right.entry_type == SftpEntryType::Directory;
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(SftpListResponse {
        path: requested_path,
        entries,
    })
}

/// Reads remote file as UTF-8 text for in-app editing.
pub async fn sftp_read_file(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpReadInput,
) -> AppResult<SftpFileContent> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = read_remote_file_text(&handle.session, &token, &input.path).await;
    handle.shutdown().await;
    result
}

async fn read_remote_file_text(
    session: &SftpSession,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<SftpFileContent> {
    let remote_path = normalize_remote_path(path);
    let mut file = open_remote_file(session, None, session_token, &remote_path).await?;
    let mut bytes = Vec::new();
    let read_result = race_cancel(None, Some(session_token), file.read_to_end(&mut bytes)).await;

    match read_result {
        Ok(Ok(_)) => {
            close_remote_file(file, None, session_token)
                .await
                .map_err(AppError::Io)?;
            Ok(SftpFileContent {
                path: remote_path,
                content: String::from_utf8_lossy(&bytes).to_string(),
            })
        }
        Ok(Err(error)) => {
            close_remote_file_quietly(file).await;
            Err(AppError::Io(error))
        }
        Err(()) => {
            close_remote_file_quietly(file).await;
            Err(operation_cancelled_error())
        }
    }
}

/// Writes text content to remote file path through SFTP.
pub async fn sftp_write_file(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpWriteInput,
) -> AppResult<()> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = write_remote_file_text(state.as_ref(), &handle.session, &token, &input).await;
    handle.shutdown().await;
    result
}

async fn write_remote_file_text(
    state: &AppState,
    session: &SftpSession,
    session_token: &CancellationToken,
    input: &SftpWriteInput,
) -> AppResult<()> {
    let remote_path = normalize_remote_path(&input.path);
    let temp_path = atomic_write_temp_path(&remote_path);

    let write_result = write_remote_bytes(
        session,
        session_token,
        temp_path.as_str(),
        input.content.as_bytes(),
    )
    .await;

    if let Err(error) = write_result {
        remove_remote_file_quietly(session, temp_path.as_str()).await;
        append_server_ops_debug_log(
            state,
            "sftp.write_file.write_failed",
            &input.session_id,
            format!(
                "path={} temp_path={} error={}",
                remote_path, temp_path, error
            ),
        );
        return Err(error);
    }

    // `russh-sftp` has no rename-with-overwrite flag; on servers that refuse to replace
    // an existing target the rename fails and the direct-write fallback below runs.
    let rename_temp = rename_remote_entry(session, session_token, &temp_path, &remote_path);
    let direct_write_target = write_remote_bytes(
        session,
        session_token,
        &remote_path,
        input.content.as_bytes(),
    );
    let unlink_temp = remove_remote_path(session, &temp_path);

    finish_atomic_write_with_fallback(
        rename_temp,
        direct_write_target,
        unlink_temp,
        |event, detail| append_server_ops_debug_log(state, event, &input.session_id, detail),
        &remote_path,
        &temp_path,
    )
    .await
}

/// Creates an empty remote file without overwriting an existing entry.
pub async fn sftp_create_file(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpCreateInput,
) -> AppResult<()> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = create_empty_remote_file(&handle.session, &token, &input.path).await;
    handle.shutdown().await;
    result
}

async fn create_empty_remote_file(
    session: &SftpSession,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<()> {
    let remote_path = normalize_remote_path(path);
    ensure_creatable_remote_path(session, session_token, &remote_path).await?;
    let flags = russh_sftp::protocol::OpenFlags::CREATE
        | russh_sftp::protocol::OpenFlags::EXCLUDE
        | russh_sftp::protocol::OpenFlags::WRITE;
    let file = match race_cancel(
        None,
        Some(session_token),
        session.open_with_flags(remote_path, flags),
    )
    .await
    {
        Ok(result) => result?,
        Err(()) => return Err(operation_cancelled_error()),
    };
    close_remote_file(file, None, session_token).await?;
    Ok(())
}

/// Creates one remote directory without overwriting an existing entry.
pub async fn sftp_create_directory(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpCreateInput,
) -> AppResult<()> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = create_remote_directory(&handle.session, &token, &input.path).await;
    handle.shutdown().await;
    result
}

async fn create_remote_directory(
    session: &SftpSession,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<()> {
    let remote_path = normalize_remote_path(path);
    ensure_creatable_remote_path(session, session_token, &remote_path).await?;
    match race_cancel(
        None,
        Some(session_token),
        session.create_dir(remote_path.as_str()),
    )
    .await
    {
        Ok(result) => result?,
        Err(()) => return Err(operation_cancelled_error()),
    }

    // `SftpSession::create_dir` cannot carry a mode, so pin the previous 0o755
    // explicitly. Every SFTP v3 server implements setstat.
    let mut attributes = FileAttributes::default();
    attributes.permissions = Some(0o755);
    match race_cancel(
        None,
        Some(session_token),
        session.set_metadata(remote_path.as_str(), attributes),
    )
    .await
    {
        Ok(result) => result?,
        Err(()) => return Err(operation_cancelled_error()),
    }
    Ok(())
}

/// Uploads base64 payload to target remote path through SFTP.
pub async fn sftp_upload_file(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpUploadInput,
) -> AppResult<()> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = upload_base64(&handle.session, &token, &input).await;
    handle.shutdown().await;
    result
}

async fn upload_base64(
    session: &SftpSession,
    session_token: &CancellationToken,
    input: &SftpUploadInput,
) -> AppResult<()> {
    let remote_path = normalize_remote_path(&input.remote_path);
    let bytes = BASE64_STANDARD.decode(input.content_base64.as_bytes())?;
    write_remote_bytes(session, session_token, &remote_path, &bytes).await
}

/// Deletes one remote file or symlink through SFTP.
pub async fn sftp_delete_entry(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpDeleteInput,
) -> AppResult<()> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = delete_remote_entry(&handle.session, &token, &input).await;
    handle.shutdown().await;
    result
}

async fn delete_remote_entry(
    session: &SftpSession,
    session_token: &CancellationToken,
    input: &SftpDeleteInput,
) -> AppResult<()> {
    let remote_path = normalize_remote_path(&input.path);
    if remote_path == "/" {
        return Err(AppError::Validation(
            "refusing to delete the remote root directory".to_string(),
        ));
    }

    match input.entry_type {
        SftpEntryType::Directory => {
            delete_remote_dir_recursive(session, session_token, &remote_path).await?
        }
        _ => match race_cancel(
            None,
            Some(session_token),
            session.remove_file(remote_path.as_str()),
        )
        .await
        {
            Ok(result) => result?,
            Err(()) => return Err(operation_cancelled_error()),
        },
    }
    Ok(())
}

/// Recursively removes a remote directory. Boxed because async recursion needs a
/// concrete future type.
fn delete_remote_dir_recursive<'a>(
    session: &'a SftpSession,
    session_token: &'a CancellationToken,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        let normalized_path = normalize_remote_path(path);
        let entries = match race_cancel(
            None,
            Some(session_token),
            session.read_dir(normalized_path.as_str()),
        )
        .await
        {
            Ok(result) => result?,
            Err(()) => return Err(operation_cancelled_error()),
        };

        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_path = join_remote_path(&normalized_path, &name);
            if entry.file_type().is_dir() {
                delete_remote_dir_recursive(session, session_token, &child_path).await?;
            } else {
                match race_cancel(
                    None,
                    Some(session_token),
                    session.remove_file(child_path.as_str()),
                )
                .await
                {
                    Ok(result) => result?,
                    Err(()) => return Err(operation_cancelled_error()),
                }
            }
        }

        match race_cancel(
            None,
            Some(session_token),
            session.remove_dir(normalized_path.as_str()),
        )
        .await
        {
            Ok(result) => result?,
            Err(()) => return Err(operation_cancelled_error()),
        }
        Ok(())
    })
}

/// Renames one remote entry within its current parent directory.
pub async fn sftp_rename_entry(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpRenameInput,
) -> AppResult<()> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = rename_remote_entry_inner(&handle.session, &token, &input).await;
    handle.shutdown().await;
    result
}

async fn rename_remote_entry_inner(
    session: &SftpSession,
    session_token: &CancellationToken,
    input: &SftpRenameInput,
) -> AppResult<()> {
    let remote_path = normalize_remote_path(&input.path);
    let target_path = renamed_remote_path(&remote_path, &input.new_name)?;
    if remote_path == target_path {
        return Ok(());
    }

    ensure_creatable_remote_path(session, session_token, &target_path).await?;
    rename_remote_entry(session, session_token, &remote_path, &target_path).await
}

/// Uploads base64 payload and emits chunk-level progress events.
pub async fn sftp_upload_file_with_progress(
    state: &Arc<AppState>,
    app: &AppHandle,
    input: SftpUploadWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let _active = super::require_active(state)?;
    let guard = SftpTransferGuard::new(state.as_ref(), &input.transfer_id);
    let transfer_token = guard.token();
    let session_token = state.shell_session_token(&input.session_id)?;

    let handle = match open_sftp_session(
        state,
        Some(app),
        &input.session_id,
        Some(&transfer_token),
        Some(&session_token),
    )
    .await
    {
        Ok(handle) => handle,
        Err(error) => {
            let remote_path = normalize_remote_path(&input.remote_path);
            let file_name = input
                .local_name
                .clone()
                .unwrap_or_else(|| extract_remote_file_name(&remote_path));
            emit_acquire_terminal(
                app,
                &input.transfer_id,
                &input.session_id,
                "upload",
                &remote_path,
                &file_name,
                &file_name,
                &transfer_token,
                &error,
            );
            return Err(error);
        }
    };
    let result =
        upload_base64_with_progress(app, &handle.session, &transfer_token, &handle.cancel, input)
            .await;
    handle.shutdown().await;
    result
}

async fn upload_base64_with_progress(
    app: &AppHandle,
    session: &SftpSession,
    transfer_token: &CancellationToken,
    session_token: &CancellationToken,
    input: SftpUploadWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let remote_path = normalize_remote_path(&input.remote_path);
    let file_name = input
        .local_name
        .clone()
        .unwrap_or_else(|| extract_remote_file_name(&remote_path));
    let local_path = file_name.clone();
    let bytes = BASE64_STANDARD.decode(input.content_base64.as_bytes())?;
    let total_bytes = bytes.len() as u64;
    let mut transferred_bytes = 0_u64;
    let mut progress_throttle = TransferProgressThrottle::new(SFTP_PROGRESS_MIN_INTERVAL);

    let events = TransferEventContext {
        transfer_id: input.transfer_id.clone(),
        session_id: input.session_id.clone(),
        direction: "upload",
        remote_path: remote_path.clone(),
        local_path: local_path.clone(),
        file_name: file_name.clone(),
    };
    events.emit(app, "started", 0, Some(total_bytes), 0.0, None);

    let mut remote_file =
        match open_remote_file_for_create(session, transfer_token, session_token, &remote_path)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                events.emit(
                    app,
                    "failed",
                    0,
                    Some(total_bytes),
                    0.0,
                    Some(error.to_string()),
                );
                return Err(error);
            }
        };

    for chunk in bytes.chunks(SFTP_TRANSFER_CHUNK_BYTES) {
        match race_cancel(
            Some(transfer_token),
            Some(session_token),
            remote_file.write_all(chunk),
        )
        .await
        {
            Err(()) => {
                close_remote_file_quietly(remote_file).await;
                remove_remote_file_quietly(session, remote_path.as_str()).await;
                events.emit(
                    app,
                    "cancelled",
                    transferred_bytes,
                    Some(total_bytes),
                    compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    Some(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string()),
                );
                return Err(transfer_cancelled_error());
            }
            Ok(Err(error)) => {
                close_remote_file_quietly(remote_file).await;
                remove_remote_file_quietly(session, remote_path.as_str()).await;
                events.emit(
                    app,
                    "failed",
                    transferred_bytes,
                    Some(total_bytes),
                    compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    Some(error.to_string()),
                );
                return Err(AppError::Io(error));
            }
            Ok(Ok(())) => {}
        }

        transferred_bytes += chunk.len() as u64;
        if progress_throttle.should_emit(Instant::now(), false) {
            events.emit(
                app,
                "progress",
                transferred_bytes,
                Some(total_bytes),
                compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                None,
            );
        }
    }

    if let Err(error) = close_remote_file(remote_file, Some(transfer_token), session_token).await {
        events.emit(
            app,
            "failed",
            transferred_bytes,
            Some(total_bytes),
            compute_transfer_percent(transferred_bytes, Some(total_bytes)),
            Some(error.to_string()),
        );
        return Err(AppError::Io(error));
    }

    let total_bytes = transferred_bytes;
    events.emit(
        app,
        "completed",
        total_bytes,
        Some(total_bytes),
        100.0,
        None,
    );

    Ok(SftpTransferResult {
        transfer_id: input.transfer_id,
        direction: "upload".to_string(),
        remote_path,
        local_path,
        file_name,
        size: total_bytes,
    })
}

/// Uploads a local file path by streaming it from disk into SFTP.
pub async fn sftp_upload_local_file_with_progress(
    state: &Arc<AppState>,
    app: &AppHandle,
    input: SftpUploadLocalWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let _active = super::require_active(state)?;
    let guard = SftpTransferGuard::new(state.as_ref(), &input.transfer_id);
    let transfer_token = guard.token();
    let session_token = state.shell_session_token(&input.session_id)?;

    let handle = match open_sftp_session(
        state,
        Some(app),
        &input.session_id,
        Some(&transfer_token),
        Some(&session_token),
    )
    .await
    {
        Ok(handle) => handle,
        Err(error) => {
            let local_path = input.local_path.trim().to_string();
            let file_name = input
                .local_name
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    Path::new(&local_path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| "upload.bin".to_string());
            emit_acquire_terminal(
                app,
                &input.transfer_id,
                &input.session_id,
                "upload",
                &normalize_remote_path(&input.remote_path),
                &local_path,
                &file_name,
                &transfer_token,
                &error,
            );
            return Err(error);
        }
    };
    let result = upload_local_file_with_progress(
        app,
        &handle.session,
        &transfer_token,
        &handle.cancel,
        input,
    )
    .await;
    handle.shutdown().await;
    result
}

async fn upload_local_file_with_progress(
    app: &AppHandle,
    session: &SftpSession,
    transfer_token: &CancellationToken,
    session_token: &CancellationToken,
    input: SftpUploadLocalWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let local_path_buf = PathBuf::from(input.local_path.trim());
    let source = inspect_local_upload_source(&local_path_buf).await?;
    let file_name = input
        .local_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| source.file_name.clone());
    let local_path = source.path.to_string_lossy().to_string();
    let total_bytes = source.total_bytes;
    let remote_path = normalize_remote_path(&input.remote_path);
    let mut local_file = tokio::fs::File::open(&source.path).await?;
    let mut transferred_bytes = 0_u64;
    let mut progress_throttle = TransferProgressThrottle::new(SFTP_PROGRESS_MIN_INTERVAL);

    let events = TransferEventContext {
        transfer_id: input.transfer_id.clone(),
        session_id: input.session_id.clone(),
        direction: "upload",
        remote_path: remote_path.clone(),
        local_path: local_path.clone(),
        file_name: file_name.clone(),
    };
    events.emit(app, "started", 0, Some(total_bytes), 0.0, None);

    let mut remote_file =
        match open_remote_file_for_create(session, transfer_token, session_token, &remote_path)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                events.emit(
                    app,
                    "failed",
                    0,
                    Some(total_bytes),
                    0.0,
                    Some(error.to_string()),
                );
                return Err(error);
            }
        };

    let mut buffer = vec![0_u8; SFTP_TRANSFER_CHUNK_BYTES];
    loop {
        let read_size = match race_cancel(
            Some(transfer_token),
            Some(session_token),
            local_file.read(&mut buffer),
        )
        .await
        {
            Err(()) => {
                close_remote_file_quietly(remote_file).await;
                remove_remote_file_quietly(session, remote_path.as_str()).await;
                events.emit(
                    app,
                    "cancelled",
                    transferred_bytes,
                    Some(total_bytes),
                    compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    Some(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string()),
                );
                return Err(transfer_cancelled_error());
            }
            Ok(Err(error)) => {
                close_remote_file_quietly(remote_file).await;
                remove_remote_file_quietly(session, remote_path.as_str()).await;
                events.emit(
                    app,
                    "failed",
                    transferred_bytes,
                    Some(total_bytes),
                    compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    Some(error.to_string()),
                );
                return Err(AppError::Io(error));
            }
            Ok(Ok(0)) => break,
            Ok(Ok(read_size)) => read_size,
        };

        match race_cancel(
            Some(transfer_token),
            Some(session_token),
            remote_file.write_all(&buffer[..read_size]),
        )
        .await
        {
            Err(()) => {
                close_remote_file_quietly(remote_file).await;
                remove_remote_file_quietly(session, remote_path.as_str()).await;
                events.emit(
                    app,
                    "cancelled",
                    transferred_bytes,
                    Some(total_bytes),
                    compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    Some(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string()),
                );
                return Err(transfer_cancelled_error());
            }
            Ok(Err(error)) => {
                close_remote_file_quietly(remote_file).await;
                remove_remote_file_quietly(session, remote_path.as_str()).await;
                events.emit(
                    app,
                    "failed",
                    transferred_bytes,
                    Some(total_bytes),
                    compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    Some(error.to_string()),
                );
                return Err(AppError::Io(error));
            }
            Ok(Ok(())) => {}
        }

        transferred_bytes += read_size as u64;
        if progress_throttle.should_emit(Instant::now(), false) {
            events.emit(
                app,
                "progress",
                transferred_bytes,
                Some(total_bytes),
                compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                None,
            );
        }
    }

    if let Err(error) = close_remote_file(remote_file, Some(transfer_token), session_token).await {
        events.emit(
            app,
            "failed",
            transferred_bytes,
            Some(total_bytes),
            compute_transfer_percent(transferred_bytes, Some(total_bytes)),
            Some(error.to_string()),
        );
        return Err(AppError::Io(error));
    }

    let total_bytes = transferred_bytes;
    events.emit(
        app,
        "completed",
        total_bytes,
        Some(total_bytes),
        100.0,
        None,
    );

    Ok(SftpTransferResult {
        transfer_id: input.transfer_id,
        direction: "upload".to_string(),
        remote_path,
        local_path,
        file_name,
        size: total_bytes,
    })
}

/// Downloads remote file and returns base64-encoded bytes for frontend save flow.
pub async fn sftp_download_file(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpDownloadInput,
) -> AppResult<SftpDownloadPayload> {
    let _active = super::require_active(state)?;
    let (handle, token) = open_operation_session(state, app, &input.session_id).await?;
    let result = download_remote_file_payload(&handle.session, &token, &input.remote_path).await;
    handle.shutdown().await;
    result
}

async fn download_remote_file_payload(
    session: &SftpSession,
    session_token: &CancellationToken,
    remote_path: &str,
) -> AppResult<SftpDownloadPayload> {
    let remote_path = normalize_remote_path(remote_path);
    let mut file = open_remote_file(session, None, session_token, &remote_path).await?;
    let mut bytes = Vec::new();
    let read_result = race_cancel(None, Some(session_token), file.read_to_end(&mut bytes)).await;

    match read_result {
        Ok(Ok(_)) => {
            close_remote_file(file, None, session_token)
                .await
                .map_err(AppError::Io)?;
        }
        Ok(Err(error)) => {
            close_remote_file_quietly(file).await;
            return Err(AppError::Io(error));
        }
        Err(()) => {
            close_remote_file_quietly(file).await;
            return Err(operation_cancelled_error());
        }
    }

    let file_name = extract_remote_file_name(&remote_path);
    Ok(SftpDownloadPayload {
        path: remote_path,
        file_name,
        content_base64: BASE64_STANDARD.encode(&bytes),
        size: bytes.len(),
    })
}

/// Downloads a remote file to a configured local directory and emits progress events.
pub async fn sftp_download_file_to_local(
    state: &Arc<AppState>,
    app: &AppHandle,
    input: SftpDownloadToLocalInput,
) -> AppResult<SftpTransferResult> {
    let _active = super::require_active(state)?;
    let guard = SftpTransferGuard::new(state.as_ref(), &input.transfer_id);
    let transfer_token = guard.token();
    let session_token = state.shell_session_token(&input.session_id)?;

    let handle = match open_sftp_session(
        state,
        Some(app),
        &input.session_id,
        Some(&transfer_token),
        Some(&session_token),
    )
    .await
    {
        Ok(handle) => handle,
        Err(error) => {
            let remote_path = normalize_remote_path(&input.remote_path);
            let file_name = extract_remote_file_name(&remote_path);
            let local_path = PathBuf::from(input.local_dir.trim())
                .join(&file_name)
                .to_string_lossy()
                .to_string();
            emit_acquire_terminal(
                app,
                &input.transfer_id,
                &input.session_id,
                "download",
                &remote_path,
                &local_path,
                &file_name,
                &transfer_token,
                &error,
            );
            return Err(error);
        }
    };
    let result = download_to_local_with_progress(
        app,
        &handle.session,
        &transfer_token,
        &handle.cancel,
        input,
    )
    .await;
    handle.shutdown().await;
    result
}

/// Emits the terminal event for a transfer that failed or was cancelled while acquiring
/// its SFTP channel, so the frontend queue always sees a terminal stage.
#[allow(clippy::too_many_arguments)]
fn emit_acquire_terminal(
    app: &AppHandle,
    transfer_id: &str,
    session_id: &str,
    direction: &'static str,
    remote_path: &str,
    local_path: &str,
    file_name: &str,
    transfer_token: &CancellationToken,
    error: &AppError,
) {
    let (stage, message) = if transfer_token.is_cancelled() {
        ("cancelled", SFTP_TRANSFER_CANCELLED_MESSAGE.to_string())
    } else {
        ("failed", error.to_string())
    };
    TransferEventContext {
        transfer_id: transfer_id.to_string(),
        session_id: session_id.to_string(),
        direction,
        remote_path: remote_path.to_string(),
        local_path: local_path.to_string(),
        file_name: file_name.to_string(),
    }
    .emit(app, stage, 0, None, 0.0, Some(message));
}

async fn download_to_local_with_progress(
    app: &AppHandle,
    session: &SftpSession,
    transfer_token: &CancellationToken,
    session_token: &CancellationToken,
    input: SftpDownloadToLocalInput,
) -> AppResult<SftpTransferResult> {
    let remote_path = normalize_remote_path(&input.remote_path);
    let file_name = extract_remote_file_name(&remote_path);
    let local_dir = normalize_local_dir(&input.local_dir)?;
    tokio::fs::create_dir_all(&local_dir).await?;
    let local_path_buf = local_dir.join(&file_name);
    let local_path = local_path_buf.to_string_lossy().to_string();

    let events = TransferEventContext {
        transfer_id: input.transfer_id.clone(),
        session_id: input.session_id.clone(),
        direction: "download",
        remote_path: remote_path.clone(),
        local_path: local_path.clone(),
        file_name: file_name.clone(),
    };

    let mut remote_file =
        match open_remote_file(session, Some(transfer_token), session_token, &remote_path).await {
            Ok(file) => file,
            Err(error) => {
                events.emit(app, "failed", 0, None, 0.0, Some(error.to_string()));
                return Err(error);
            }
        };

    let total_bytes = match race_cancel(
        Some(transfer_token),
        Some(session_token),
        session.metadata(remote_path.as_str()),
    )
    .await
    {
        Ok(result) => result.ok().and_then(|metadata| metadata.size),
        Err(()) => {
            close_remote_file_quietly(remote_file).await;
            events.emit(
                app,
                "cancelled",
                0,
                None,
                0.0,
                Some(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string()),
            );
            return Err(transfer_cancelled_error());
        }
    };

    let mut local_file = match tokio::fs::File::create(&local_path_buf).await {
        Ok(file) => file,
        Err(error) => {
            close_remote_file_quietly(remote_file).await;
            events.emit(app, "failed", 0, total_bytes, 0.0, Some(error.to_string()));
            return Err(AppError::Io(error));
        }
    };

    let mut transferred_bytes = 0_u64;
    let mut progress_throttle = TransferProgressThrottle::new(SFTP_PROGRESS_MIN_INTERVAL);
    events.emit(app, "started", 0, total_bytes, 0.0, None);

    let mut buffer = vec![0_u8; SFTP_TRANSFER_CHUNK_BYTES];
    loop {
        let read_size = match race_cancel(
            Some(transfer_token),
            Some(session_token),
            remote_file.read(&mut buffer),
        )
        .await
        {
            Err(()) => {
                close_remote_file_quietly(remote_file).await;
                // Windows refuses to delete a file that still has an open handle.
                drop(local_file);
                let _ = tokio::fs::remove_file(&local_path_buf).await;
                events.emit(
                    app,
                    "cancelled",
                    transferred_bytes,
                    total_bytes,
                    compute_transfer_percent(transferred_bytes, total_bytes),
                    Some(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string()),
                );
                return Err(transfer_cancelled_error());
            }
            Ok(Err(error)) => {
                close_remote_file_quietly(remote_file).await;
                events.emit(
                    app,
                    "failed",
                    transferred_bytes,
                    total_bytes,
                    compute_transfer_percent(transferred_bytes, total_bytes),
                    Some(error.to_string()),
                );
                return Err(AppError::Io(error));
            }
            Ok(Ok(0)) => break,
            Ok(Ok(read_size)) => read_size,
        };

        match race_cancel(
            Some(transfer_token),
            Some(session_token),
            local_file.write_all(&buffer[..read_size]),
        )
        .await
        {
            Err(()) => {
                close_remote_file_quietly(remote_file).await;
                drop(local_file);
                let _ = tokio::fs::remove_file(&local_path_buf).await;
                events.emit(
                    app,
                    "cancelled",
                    transferred_bytes,
                    total_bytes,
                    compute_transfer_percent(transferred_bytes, total_bytes),
                    Some(SFTP_TRANSFER_CANCELLED_MESSAGE.to_string()),
                );
                return Err(transfer_cancelled_error());
            }
            Ok(Err(error)) => {
                close_remote_file_quietly(remote_file).await;
                events.emit(
                    app,
                    "failed",
                    transferred_bytes,
                    total_bytes,
                    compute_transfer_percent(transferred_bytes, total_bytes),
                    Some(error.to_string()),
                );
                return Err(AppError::Io(error));
            }
            Ok(Ok(())) => {}
        }

        transferred_bytes += read_size as u64;
        if progress_throttle.should_emit(Instant::now(), false) {
            events.emit(
                app,
                "progress",
                transferred_bytes,
                total_bytes,
                compute_transfer_percent(transferred_bytes, total_bytes),
                None,
            );
        }
    }

    if let Err(error) = close_remote_file(remote_file, Some(transfer_token), session_token).await {
        events.emit(
            app,
            "failed",
            transferred_bytes,
            total_bytes,
            compute_transfer_percent(transferred_bytes, total_bytes),
            Some(error.to_string()),
        );
        return Err(AppError::Io(error));
    }
    if let Err(error) = local_file.flush().await {
        events.emit(
            app,
            "failed",
            transferred_bytes,
            total_bytes,
            compute_transfer_percent(transferred_bytes, total_bytes),
            Some(error.to_string()),
        );
        return Err(AppError::Io(error));
    }

    // Report what was actually written locally, not the earlier metadata size: a remote
    // file truncated mid-read must not be announced as a complete transfer.
    let final_size = transferred_bytes;
    events.emit(app, "completed", final_size, Some(final_size), 100.0, None);

    Ok(SftpTransferResult {
        transfer_id: input.transfer_id,
        direction: "download".to_string(),
        remote_path,
        local_path,
        file_name,
        size: final_size,
    })
}

/// Returns a sensible default local download directory for current OS.
pub fn default_download_dir() -> String {
    resolve_default_download_dir().to_string_lossy().to_string()
}

/// Requests cancellation for a running SFTP transfer.
///
/// Delegates to the plugin state; cancelling is how a user winds an
/// operation down, so it deliberately works on a deactivated extension.
pub(crate) fn cancel_transfer(state: &AppState, transfer_id: &str) -> bool {
    super::cancel_transfer(state, transfer_id)
}

/// Opens a remote file for reading, honouring cancellation while the request is in flight.
async fn open_remote_file(
    session: &SftpSession,
    transfer_token: Option<&CancellationToken>,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<File> {
    match race_cancel(transfer_token, Some(session_token), session.open(path)).await {
        Ok(result) => Ok(result?),
        Err(()) => Err(acquire_cancelled_error(transfer_token)),
    }
}

/// Creates (or truncates) a remote file for writing, honouring both tokens.
async fn open_remote_file_for_create(
    session: &SftpSession,
    transfer_token: &CancellationToken,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<File> {
    match race_cancel(
        Some(transfer_token),
        Some(session_token),
        session.create(path),
    )
    .await
    {
        Ok(result) => Ok(result?),
        Err(()) => Err(transfer_cancelled_error()),
    }
}

/// Writes all bytes to a remote path, closing the handle before returning.
async fn write_remote_bytes(
    session: &SftpSession,
    session_token: &CancellationToken,
    path: &str,
    bytes: &[u8],
) -> AppResult<()> {
    let mut file = match race_cancel(None, Some(session_token), session.create(path)).await {
        Ok(result) => result?,
        Err(()) => return Err(operation_cancelled_error()),
    };

    let write_result = race_cancel(None, Some(session_token), file.write_all(bytes)).await;

    match write_result {
        Ok(Ok(())) => close_remote_file(file, None, session_token)
            .await
            .map_err(AppError::Io),
        Ok(Err(error)) => {
            close_remote_file_quietly(file).await;
            Err(AppError::Io(error))
        }
        Err(()) => {
            close_remote_file_quietly(file).await;
            Err(operation_cancelled_error())
        }
    }
}

/// Renames a remote path without any overwrite handling of its own.
async fn rename_remote_entry(
    session: &SftpSession,
    token: &CancellationToken,
    from: &str,
    to: &str,
) -> AppResult<()> {
    match race_cancel(None, Some(token), session.rename(from, to)).await {
        Ok(result) => Ok(result?),
        Err(()) => Err(operation_cancelled_error()),
    }
}

async fn remove_remote_path(session: &SftpSession, path: &str) -> AppResult<()> {
    session.remove_file(path).await?;
    Ok(())
}

/// Best-effort, bounded close for read/cleanup paths where a close error is not
/// actionable and waiting must not delay cancellation.
async fn close_remote_file(
    file: File,
    transfer_token: Option<&CancellationToken>,
    session_token: &CancellationToken,
) -> std::io::Result<()> {
    match race_cancel(transfer_token, Some(session_token), file.close()).await {
        Ok(result) => result,
        Err(()) => Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            SFTP_TRANSFER_CANCELLED_MESSAGE,
        )),
    }
}

async fn close_remote_file_quietly(file: File) {
    let _ = tokio::time::timeout(SFTP_CLEANUP_TIMEOUT, file.close()).await;
}

/// Best-effort, bounded unlink of a partial remote file after a failed/cancelled transfer.
async fn remove_remote_file_quietly(session: &SftpSession, path: &str) {
    let _ = tokio::time::timeout(SFTP_CLEANUP_TIMEOUT, session.remove_file(path)).await;
}

struct SftpTransferGuard<'a> {
    state: &'a AppState,
    transfer_id: String,
    token: CancellationToken,
}

impl<'a> SftpTransferGuard<'a> {
    fn new(state: &'a AppState, transfer_id: &str) -> Self {
        let token = state.sftp_plugin().state.begin_transfer(transfer_id);
        Self {
            state,
            transfer_id: transfer_id.to_string(),
            token,
        }
    }

    fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for SftpTransferGuard<'_> {
    fn drop(&mut self) {
        self.state
            .sftp_plugin()
            .state
            .clear_transfer(&self.transfer_id);
    }
}

/// Event fields shared by every stage of one transfer, so each emit only names the
/// stage-specific values.
struct TransferEventContext {
    transfer_id: String,
    session_id: String,
    direction: &'static str,
    remote_path: String,
    local_path: String,
    file_name: String,
}

impl TransferEventContext {
    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        app: &AppHandle,
        stage: &str,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
        percent: f64,
        message: Option<String>,
    ) {
        let stage = if stage == "failed"
            && message
                .as_deref()
                .is_some_and(|text| text.contains("cancelled by user"))
        {
            "cancelled"
        } else {
            stage
        };
        emit_sftp_transfer_event(
            app,
            SftpTransferEvent {
                transfer_id: self.transfer_id.clone(),
                session_id: self.session_id.clone(),
                direction: self.direction.to_string(),
                stage: stage.to_string(),
                remote_path: self.remote_path.clone(),
                local_path: Some(self.local_path.clone()),
                file_name: self.file_name.clone(),
                transferred_bytes,
                total_bytes,
                percent,
                message,
            },
        );
    }
}

fn emit_sftp_transfer_event(app: &AppHandle, event: SftpTransferEvent) {
    let _ = app.emit(SFTP_TRANSFER_EVENT, event);
}

pub(crate) struct TransferProgressThrottle {
    min_interval: Duration,
    last_emit_at: Option<Instant>,
}

impl TransferProgressThrottle {
    pub(crate) fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_emit_at: None,
        }
    }

    pub(crate) fn should_emit(&mut self, now: Instant, force: bool) -> bool {
        if force {
            self.last_emit_at = Some(now);
            return true;
        }

        match self.last_emit_at {
            Some(last_emit_at)
                if now.saturating_duration_since(last_emit_at) < self.min_interval =>
            {
                false
            }
            _ => {
                self.last_emit_at = Some(now);
                true
            }
        }
    }
}

pub(crate) fn compute_transfer_percent(transferred_bytes: u64, total_bytes: Option<u64>) -> f64 {
    match total_bytes {
        Some(0) | None => 0.0,
        Some(total) => {
            let ratio = (transferred_bytes as f64 / total as f64) * 100.0;
            ratio.clamp(0.0, 100.0)
        }
    }
}

pub(crate) fn entry_type_from_file_type(file_type: FileType) -> SftpEntryType {
    match file_type {
        FileType::Dir => SftpEntryType::Directory,
        FileType::File => SftpEntryType::File,
        FileType::Symlink => SftpEntryType::Symlink,
        FileType::Other => SftpEntryType::Other,
    }
}

pub(crate) fn extract_remote_file_name(remote_path: &str) -> String {
    remote_path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "download.bin".to_string())
}

pub(crate) fn normalize_local_dir(value: &str) -> AppResult<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "download directory cannot be empty".to_string(),
        ));
    }
    Ok(PathBuf::from(trimmed))
}

fn atomic_write_temp_path(remote_path: &str) -> String {
    atomic_write_temp_path_with_suffix(remote_path, &Uuid::new_v4().to_string())
}

pub(crate) fn atomic_write_temp_path_with_suffix(remote_path: &str, suffix: &str) -> String {
    let normalized = normalize_remote_path(remote_path);
    let trimmed = normalized.trim_end_matches('/');
    let (dir, file_name) = match trimmed.rsplit_once('/') {
        Some(("", name)) => ("/", name),
        Some((parent, name)) => (parent, name),
        None => ("", trimmed),
    };
    let temp_name = format!(".{file_name}.eshell-tmp-{suffix}");

    if dir.is_empty() {
        temp_name
    } else if dir == "/" {
        format!("/{temp_name}")
    } else {
        format!("{dir}/{temp_name}")
    }
}

pub(crate) fn renamed_remote_path(remote_path: &str, new_name: &str) -> AppResult<String> {
    let normalized = normalize_remote_path(remote_path);
    if normalized == "/" {
        return Err(AppError::Validation(
            "cannot rename the remote root directory".to_string(),
        ));
    }

    let name = new_name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(AppError::Validation(
            "new remote name must not be empty or contain path separators".to_string(),
        ));
    }

    let (parent, _) = normalized
        .rsplit_once('/')
        .ok_or_else(|| AppError::Validation("remote path is invalid".to_string()))?;
    if parent.is_empty() {
        Ok(format!("/{name}"))
    } else {
        Ok(format!("{parent}/{name}"))
    }
}

/// Runs the atomic-write rename, falling back to a direct target write when the
/// server refuses to replace an existing file.
///
/// The three IO steps and the failure logger are passed as futures/closure so the
/// fallback decision logic stays testable without a live SFTP session.
pub(crate) async fn finish_atomic_write_with_fallback<R, D, U, L>(
    rename_temp: R,
    direct_write_target: D,
    unlink_temp: U,
    mut log_failure: L,
    remote_path: &str,
    temp_path: &str,
) -> AppResult<()>
where
    R: Future<Output = AppResult<()>>,
    D: Future<Output = AppResult<()>>,
    U: Future<Output = AppResult<()>>,
    L: FnMut(&str, String),
{
    if let Err(error) = rename_temp.await {
        log_failure(
            "sftp.write_file.rename_failed",
            format!(
                "path={} temp_path={} error={}",
                remote_path, temp_path, error
            ),
        );

        match direct_write_target.await {
            Ok(()) => {
                if let Err(cleanup_error) = unlink_temp.await {
                    log_failure(
                        "sftp.write_file.temp_cleanup_failed",
                        format!(
                            "path={} temp_path={} error={}",
                            remote_path, temp_path, cleanup_error
                        ),
                    );
                }
                log_failure(
                    "sftp.write_file.direct_write_fallback_succeeded",
                    format!("path={} temp_path={}", remote_path, temp_path),
                );
                return Ok(());
            }
            Err(fallback_error) => {
                log_failure(
                    "sftp.write_file.direct_write_fallback_failed",
                    format!(
                        "path={} temp_path={} error={}",
                        remote_path, temp_path, fallback_error
                    ),
                );
                return Err(fallback_error);
            }
        }
    }

    Ok(())
}

/// Checks a remote path is absent and not the root before creating anything.
async fn ensure_creatable_remote_path(
    session: &SftpSession,
    session_token: &CancellationToken,
    path: &str,
) -> AppResult<()> {
    let normalized_path = normalize_remote_path(path);
    if normalized_path == "/" {
        return Err(AppError::Validation(
            "refusing to create the remote root path".to_string(),
        ));
    }

    let exists = match race_cancel(
        None,
        Some(session_token),
        session.try_exists(normalized_path.as_str()),
    )
    .await
    {
        Ok(result) => result?,
        Err(()) => return Err(operation_cancelled_error()),
    };
    if exists {
        return Err(AppError::Validation(format!(
            "remote path already exists: {normalized_path}"
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct LocalUploadSource {
    path: PathBuf,
    pub(crate) file_name: String,
    pub(crate) total_bytes: u64,
}

pub(crate) async fn inspect_local_upload_source(path: &Path) -> AppResult<LocalUploadSource> {
    let metadata = tokio::fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(AppError::Validation(format!(
            "local upload path is not a regular file: {}",
            path.display()
        )));
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| {
            AppError::Validation(format!(
                "local upload path has no file name: {}",
                path.display()
            ))
        })?;

    Ok(LocalUploadSource {
        path: path.to_path_buf(),
        file_name,
        total_bytes: metadata.len(),
    })
}

fn resolve_default_download_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(user_profile).join("Downloads");
        }
    } else if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Downloads");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("downloads")
}

/// Normalizes a remote POSIX path. Shared with `service` for cwd sanitization.
pub fn normalize_remote_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return "/".to_string();
    }

    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }

    if !normalized.starts_with('/') {
        normalized.insert(0, '/');
    }

    if normalized.len() > 1 {
        normalized = normalized.trim_end_matches('/').to_string();
    }

    if normalized.is_empty() {
        "/".to_string()
    } else {
        normalized
    }
}

pub(crate) fn join_remote_path(base: &str, name: &str) -> String {
    let normalized_base = normalize_remote_path(base);
    if normalized_base == "/" {
        format!("/{}", name)
    } else {
        format!(
            "{}/{}",
            normalized_base.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    }
}
