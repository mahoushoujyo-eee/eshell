use uuid::Uuid;

use crate::error::AppResult;
use crate::models::{now_rfc3339, AiConfig};
use crate::state::AppState;

use super::context::{build_planner_system_prompt, load_session_context};
use super::openai;
use super::types::{
    OpsAgentCompactConversationResult, OpsAgentConversation, OpsAgentMessage, OpsAgentRole,
};

const COMPACT_MIN_MESSAGES: usize = 3;
const COMPACT_MIN_MESSAGES_TO_KEEP: usize = 2;
const COMPACT_MAX_TAIL_RATIO: usize = 4;
const COMPACT_MIN_TAIL_TOKENS: usize = 1_500;
const COMPACT_MAX_TAIL_TOKENS: usize = 24_000;
const COMPACT_SUMMARY_MAX_TOKENS: u32 = 1_200;
const COMPACT_MESSAGE_PREVIEW_CHARS: usize = 2_000;
const COMPACT_TOOL_PREVIEW_CHARS: usize = 1_200;
const COMPACT_SHELL_CONTEXT_PREVIEW_CHARS: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpsAgentCompactMode {
    Auto,
    Manual,
}

pub async fn auto_compact_conversation_if_needed(
    state: &AppState,
    conversation_id: &str,
    session_id: Option<&str>,
    config: &AiConfig,
) -> AppResult<Option<OpsAgentCompactConversationResult>> {
    let conversation = state.ops_agent.get_conversation(conversation_id)?;
    let estimated_tokens = estimate_conversation_tokens(state, config, &conversation, session_id);
    if estimated_tokens <= config.max_context_tokens as usize {
        return Ok(None);
    }

    let result =
        compact_conversation_history(state, conversation, session_id, config, OpsAgentCompactMode::Auto)
            .await?;
    Ok(Some(result))
}

pub async fn compact_conversation_history(
    state: &AppState,
    conversation: OpsAgentConversation,
    session_id: Option<&str>,
    config: &AiConfig,
    mode: OpsAgentCompactMode,
) -> AppResult<OpsAgentCompactConversationResult> {
    let estimated_tokens_before = estimate_conversation_tokens(state, config, &conversation, session_id);

    if conversation.messages.len() < COMPACT_MIN_MESSAGES {
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note: "The current conversation is still too short, so compaction is not needed yet.".to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    let keep_start = find_keep_start_index(&conversation.messages, config.max_context_tokens as usize);
    if keep_start == 0 || keep_start >= conversation.messages.len() {
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note: "The current conversation is still short enough, so there is no need to compact it right now.".to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    let messages_to_summarize = conversation.messages[..keep_start].to_vec();
    let messages_to_keep = conversation.messages[keep_start..].to_vec();
    if messages_to_summarize.is_empty() {
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note: "The current conversation is still short enough, so there is no need to compact it right now.".to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    let transcript = build_compaction_transcript(&messages_to_summarize);
    let summary = match openai::compact_history_summary(config, &transcript, COMPACT_SUMMARY_MAX_TOKENS)
        .await
    {
        Ok(value) => value.trim().to_string(),
        Err(_) => build_fallback_summary(&messages_to_summarize),
    };

    let boundary_message = OpsAgentMessage {
        id: Uuid::new_v4().to_string(),
        role: OpsAgentRole::System,
        content: match mode {
            OpsAgentCompactMode::Auto => {
                "Context compaction boundary: older conversation history was summarized automatically to stay inside the configured context window.".to_string()
            }
            OpsAgentCompactMode::Manual => {
                "Context compaction boundary: older conversation history was summarized manually by the user.".to_string()
            }
        },
        created_at: now_rfc3339(),
        tool_kind: None,
        shell_context: None,
    };
    let summary_message = OpsAgentMessage {
        id: Uuid::new_v4().to_string(),
        role: OpsAgentRole::Assistant,
        content: format!(
            "## Context Summary\n\n{}\n\n{}",
            match mode {
                OpsAgentCompactMode::Auto => {
                    "Earlier conversation history was compressed automatically."
                }
                OpsAgentCompactMode::Manual => {
                    "Earlier conversation history was compressed manually."
                }
            },
            summary.trim()
        ),
        created_at: now_rfc3339(),
        tool_kind: None,
        shell_context: None,
    };

    let compacted_messages = [
        vec![boundary_message, summary_message],
        messages_to_keep,
    ]
    .concat();

    let updated = state
        .ops_agent
        .replace_messages(&conversation.id, compacted_messages)?;
    let estimated_tokens_after = estimate_conversation_tokens(state, config, &updated, session_id);

    Ok(OpsAgentCompactConversationResult {
        conversation: updated,
        compacted: true,
        note: match mode {
            OpsAgentCompactMode::Auto => "Conversation history was compacted automatically.".to_string(),
            OpsAgentCompactMode::Manual => "Conversation history was compacted.".to_string(),
        },
        estimated_tokens_before,
        estimated_tokens_after,
    })
}

pub fn estimate_conversation_tokens(
    state: &AppState,
    config: &AiConfig,
    conversation: &OpsAgentConversation,
    session_id: Option<&str>,
) -> usize {
    let session_context = load_session_context(state, session_id.or(conversation.session_id.as_deref()));
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let system_prompt = build_planner_system_prompt(&config.system_prompt, &session_context, &tool_hints);
    let messages_text = conversation
        .messages
        .iter()
        .map(render_message_for_estimation)
        .collect::<Vec<_>>()
        .join("\n\n");
    rough_token_estimate(&format!("{system_prompt}\n\n{messages_text}"))
}

fn find_keep_start_index(messages: &[OpsAgentMessage], max_context_tokens: usize) -> usize {
    if messages.len() <= COMPACT_MIN_MESSAGES_TO_KEEP {
        return 0;
    }

    let mut keep_tokens = 0usize;
    let tail_target_tokens = (max_context_tokens / COMPACT_MAX_TAIL_RATIO)
        .clamp(COMPACT_MIN_TAIL_TOKENS, COMPACT_MAX_TAIL_TOKENS);
    let mut keep_count = 0usize;
    let mut keep_start = messages.len();

    for index in (0..messages.len()).rev() {
        let message_tokens = rough_token_estimate(&render_message_for_estimation(&messages[index]));
        if keep_count < COMPACT_MIN_MESSAGES_TO_KEEP || keep_tokens < tail_target_tokens {
            keep_tokens += message_tokens;
            keep_count += 1;
            keep_start = index;
            continue;
        }
        break;
    }

    keep_start.min(messages.len())
}

fn build_compaction_transcript(messages: &[OpsAgentMessage]) -> String {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            format!(
                "{}. {}",
                index + 1,
                render_message_for_compaction(message)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_message_for_estimation(message: &OpsAgentMessage) -> String {
    let mut base = format!(
        "{}: {}",
        match message.role {
            OpsAgentRole::System => "System",
            OpsAgentRole::User => "User",
            OpsAgentRole::Assistant => "Assistant",
            OpsAgentRole::Tool => "Tool",
        },
        message.content
    );
    if let Some(shell_context) = &message.shell_context {
        base.push_str("\nShell context:\n");
        base.push_str(&shell_context.content);
    }
    base
}

fn render_message_for_compaction(message: &OpsAgentMessage) -> String {
    let preview_limit = if message.role == OpsAgentRole::Tool {
        COMPACT_TOOL_PREVIEW_CHARS
    } else {
        COMPACT_MESSAGE_PREVIEW_CHARS
    };
    let mut text = format!(
        "{}:\n{}",
        match message.role {
            OpsAgentRole::System => "System",
            OpsAgentRole::User => "User",
            OpsAgentRole::Assistant => "Assistant",
            OpsAgentRole::Tool => "Tool",
        },
        truncate_text(&message.content, preview_limit)
    );

    if let Some(shell_context) = &message.shell_context {
        text.push_str("\nAttached shell context:\n");
        text.push_str(&truncate_text(
            &shell_context.content,
            COMPACT_SHELL_CONTEXT_PREVIEW_CHARS,
        ));
    }

    text
}

fn build_fallback_summary(messages: &[OpsAgentMessage]) -> String {
    let mut bullets = Vec::new();
    bullets.push("- The earlier conversation was compacted with a local fallback summary.".to_string());

    for message in messages.iter().rev().take(8).rev() {
        let label = match message.role {
            OpsAgentRole::System => "System",
            OpsAgentRole::User => "User",
            OpsAgentRole::Assistant => "Assistant",
            OpsAgentRole::Tool => "Tool",
        };
        bullets.push(format!(
            "- {}: {}",
            label,
            truncate_text(
                &message.content.replace('\n', " "),
                if message.role == OpsAgentRole::Tool { 180 } else { 220 }
            )
        ));
    }

    bullets.join("\n")
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}

fn rough_token_estimate(value: &str) -> usize {
    ((value.len() as f64) / 4.0).round() as usize
}
