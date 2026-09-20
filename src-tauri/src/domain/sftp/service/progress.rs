use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::common::error::AppError;
use crate::domain::sftp::consts::*;
use crate::domain::sftp::model::SftpTransferEvent;
use crate::state::AppState;

/// Emits the terminal event for a transfer that failed or was cancelled while acquiring
/// its SFTP channel, so the frontend queue always sees a terminal stage.
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_acquire_terminal(
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

pub(crate) struct SftpTransferGuard<'a> {
    state: &'a AppState,
    transfer_id: String,
    token: CancellationToken,
}

impl<'a> SftpTransferGuard<'a> {
    pub(crate) fn new(state: &'a AppState, transfer_id: &str) -> Self {
        let token = state.sftp_plugin().state.begin_transfer(transfer_id);
        Self {
            state,
            transfer_id: transfer_id.to_string(),
            token,
        }
    }

    pub(crate) fn token(&self) -> CancellationToken {
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
pub(crate) struct TransferEventContext {
    pub(crate) transfer_id: String,
    pub(crate) session_id: String,
    pub(crate) direction: &'static str,
    pub(crate) remote_path: String,
    pub(crate) local_path: String,
    pub(crate) file_name: String,
}

impl TransferEventContext {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn emit(
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

pub(crate) fn emit_sftp_transfer_event(app: &AppHandle, event: SftpTransferEvent) {
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
