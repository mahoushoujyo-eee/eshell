use crate::error::{AppError, AppResult};

use super::super::events::OpsAgentEventEmitter;
use super::super::run_registry::OpsAgentRunHandle;
use super::OPS_AGENT_RUN_CANCELLED;

pub(super) fn emit_static_reply(text: String, emitter: &OpsAgentEventEmitter) -> String {
    emitter.delta(text.clone());
    text
}

pub(super) fn ensure_run_not_cancelled(run_handle: &OpsAgentRunHandle) -> AppResult<()> {
    if run_handle.is_cancelled() {
        return Err(AppError::Runtime(OPS_AGENT_RUN_CANCELLED.to_string()));
    }
    Ok(())
}

pub(super) fn is_run_cancelled_error(error: &AppError) -> bool {
    matches!(error, AppError::Runtime(message) if message == OPS_AGENT_RUN_CANCELLED)
}

pub(super) fn normalized_reply(reply: String, fallback: &str) -> String {
    if reply.trim().is_empty() {
        fallback.to_string()
    } else {
        reply
    }
}

pub(super) fn normalize_session_id(session_id: Option<&str>) -> Option<String> {
    let session_id = session_id?;
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn truncate_for_log(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}
