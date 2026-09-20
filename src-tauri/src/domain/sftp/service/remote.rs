use std::future::Future;
use std::path::{Path, PathBuf};

use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::domain::sftp::consts::*;

use super::paths::normalize_remote_path;
use super::session::{
    acquire_cancelled_error, operation_cancelled_error, race_cancel, transfer_cancelled_error,
};

/// Opens a remote file for reading, honouring cancellation while the request is in flight.
pub(crate) async fn open_remote_file(
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
pub(crate) async fn open_remote_file_for_create(
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
pub(crate) async fn write_remote_bytes(
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
pub(crate) async fn rename_remote_entry(
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

pub(crate) async fn remove_remote_path(session: &SftpSession, path: &str) -> AppResult<()> {
    session.remove_file(path).await?;
    Ok(())
}

/// Best-effort, bounded close for read/cleanup paths where a close error is not
/// actionable and waiting must not delay cancellation.
pub(crate) async fn close_remote_file(
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

pub(crate) async fn close_remote_file_quietly(file: File) {
    let _ = tokio::time::timeout(SFTP_CLEANUP_TIMEOUT, file.close()).await;
}

/// Best-effort, bounded unlink of a partial remote file after a failed/cancelled transfer.
pub(crate) async fn remove_remote_file_quietly(session: &SftpSession, path: &str) {
    let _ = tokio::time::timeout(SFTP_CLEANUP_TIMEOUT, session.remove_file(path)).await;
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
pub(crate) async fn ensure_creatable_remote_path(
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
    pub(crate) path: PathBuf,
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
