use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh_sftp::client::SftpSession;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::domain::sftp::consts::*;
use crate::domain::sftp::model::{
    SftpTransferResult, SftpUploadLocalWithProgressInput, SftpUploadWithProgressInput,
};
use crate::domain::sftp::service::require_active;
use crate::state::AppState;

use super::paths::{extract_remote_file_name, normalize_remote_path};
use super::progress::{
    compute_transfer_percent, emit_acquire_terminal, SftpTransferGuard, TransferEventContext,
    TransferProgressThrottle,
};
use super::remote::{
    close_remote_file, close_remote_file_quietly, inspect_local_upload_source,
    open_remote_file_for_create, remove_remote_file_quietly,
};
use super::session::{open_sftp_session, race_cancel, transfer_cancelled_error};

/// Uploads base64 payload and emits chunk-level progress events.
pub async fn sftp_upload_file_with_progress(
    state: &Arc<AppState>,
    app: &AppHandle,
    input: SftpUploadWithProgressInput,
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
