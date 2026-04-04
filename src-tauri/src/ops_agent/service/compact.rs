use std::sync::Arc;

use crate::error::AppResult;
use crate::state::AppState;

use super::super::compact::{self, OpsAgentCompactMode};
use super::super::types::{
    OpsAgentCompactConversationInput, OpsAgentCompactConversationResult,
};

pub async fn compact_conversation(
    state: Arc<AppState>,
    input: OpsAgentCompactConversationInput,
) -> AppResult<OpsAgentCompactConversationResult> {
    let conversation = state.ops_agent.get_conversation(&input.conversation_id)?;
    let config = state.storage.get_ai_config();
    compact::compact_conversation_history(
        state.as_ref(),
        conversation.clone(),
        conversation.session_id.as_deref(),
        &config,
        OpsAgentCompactMode::Manual,
    )
    .await
}
