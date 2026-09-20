use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use russh_sftp::client::SftpSession;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::domain::sftp::consts::*;
use crate::domain::sftp::model::{SftpDownloadToLocalInput, SftpTransferResult};
use crate::domain::sftp::service::require_active;
use crate::state::AppState;

use super::paths::{extract_remote_file_name, normalize_local_dir, normalize_remote_path};
use super::progress::{
    compute_transfer_percent, emit_acquire_terminal, SftpTransferGuard, TransferEventContext,
    TransferProgressThrottle,
};
use super::remote::{close_remote_file, close_remote_file_quietly, open_remote_file};
use super::session::{open_sftp_session, race_cancel, transfer_cancelled_error};

/// Downloads a remote file to a configured local directory and emits progress events.
pub async fn sftp_download_file_to_local(
    state: &Arc<AppState>,
    app: &AppHandle,
    input: SftpDownloadToLocalInput,
) -> AppResult<SftpTransferResult> {
    let _active = require_active(state)?;
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
