use std::sync::Arc;

use crate::error::AppResult;
use crate::ops_agent::core::compaction::{compact_conversation_history, OpsAgentCompactMode};
use crate::ops_agent::domain::types::{
    OpsAgentCompactConversationInput, OpsAgentCompactConversationResult,
};
use crate::ops_agent::infrastructure::logging::append_debug_log;
use crate::state::AppState;

pub async fn compact_conversation(
    state: Arc<AppState>,
    input: OpsAgentCompactConversationInput,
) -> AppResult<OpsAgentCompactConversationResult> {
    append_debug_log(
        state.as_ref(),
        "application.compaction.request",
        None,
        Some(input.conversation_id.as_str()),
        "manual compaction requested",
    );
    let conversation = state.ops_agent.get_conversation(&input.conversation_id)?;
    let config = state.storage.get_ai_config();
    let result = compact_conversation_history(
        state.as_ref(),
        conversation.clone(),
        conversation.session_id.as_deref(),
        &config,
        OpsAgentCompactMode::Manual,
    )
    .await?;
    append_debug_log(
        state.as_ref(),
        "application.compaction.completed",
        None,
        Some(result.conversation.id.as_str()),
        format!(
            "compacted={} estimated_before={} estimated_after={}",
            result.compacted, result.estimated_tokens_before, result.estimated_tokens_after
        ),
    );
    Ok(result)
}
