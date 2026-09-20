use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::common::logging::append_server_ops_debug_log;
use crate::domain::sftp::model::{
    SftpCreateInput, SftpDeleteInput, SftpDownloadInput, SftpDownloadPayload, SftpEntry,
    SftpEntryType, SftpFileContent, SftpListInput, SftpListResponse, SftpReadInput,
    SftpRenameInput, SftpUploadInput, SftpWriteInput,
};
use crate::domain::sftp::service::require_active;
use crate::state::AppState;

use super::paths::{
    atomic_write_temp_path, entry_type_from_file_type, extract_remote_file_name, join_remote_path,
    normalize_remote_path, renamed_remote_path,
};
use super::remote::{
    close_remote_file, close_remote_file_quietly, ensure_creatable_remote_path,
    finish_atomic_write_with_fallback, open_remote_file, remove_remote_file_quietly,
    remove_remote_path, rename_remote_entry, write_remote_bytes,
};
use super::session::{open_operation_session, operation_cancelled_error, race_cancel};

/// Lists directory entries through SFTP.
pub async fn sftp_list_dir(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpListInput,
) -> AppResult<SftpListResponse> {
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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
    let _active = require_active(state)?;
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

/// Downloads remote file and returns base64-encoded bytes for frontend save flow.
pub async fn sftp_download_file(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    input: SftpDownloadInput,
) -> AppResult<SftpDownloadPayload> {
    let _active = require_active(state)?;
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
