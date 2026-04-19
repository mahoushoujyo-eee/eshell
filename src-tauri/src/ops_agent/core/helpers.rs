use crate::error::{AppError, AppResult};
use crate::ops_agent::infrastructure::run_registry::OpsAgentRunHandle;
use crate::ops_agent::transport::events::OpsAgentEventEmitter;

use super::OPS_AGENT_RUN_CANCELLED;

pub(crate) fn emit_static_reply(text: String, emitter: &OpsAgentEventEmitter) -> String {
    emitter.delta(text.clone());
    text
}

pub(crate) fn ensure_run_not_cancelled(run_handle: &OpsAgentRunHandle) -> AppResult<()> {
    if run_handle.is_cancelled() {
        return Err(AppError::Runtime(OPS_AGENT_RUN_CANCELLED.to_string()));
    }
    Ok(())
}

pub(crate) fn is_run_cancelled_error(error: &AppError) -> bool {
    matches!(error, AppError::Runtime(message) if message == OPS_AGENT_RUN_CANCELLED)
}

pub(crate) fn normalized_reply(reply: String, fallback: &str) -> String {
    if reply.trim().is_empty() {
        fallback.to_string()
    } else {
        reply
    }
}

pub(crate) fn truncate_for_log(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}
