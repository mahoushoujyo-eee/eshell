use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;
use crate::models::{now_rfc3339, AiConfig};
use crate::state::AppState;

use super::llm;
use super::prompting::{build_planner_system_prompt, load_session_context};
use crate::ops_agent::domain::types::{
    OpsAgentCompactConversationResult, OpsAgentConversation, OpsAgentMessage, OpsAgentRole,
};
use crate::ops_agent::infrastructure::logging::{truncate_for_log, OpsAgentLogContext};

const COMPACT_MIN_MESSAGES: usize = 3;
const COMPACT_MIN_MESSAGES_TO_KEEP: usize = 2;
const COMPACT_MAX_TAIL_RATIO: usize = 4;
const COMPACT_MIN_TAIL_TOKENS: usize = 1_500;
const COMPACT_MAX_TAIL_TOKENS: usize = 24_000;
const COMPACT_SUMMARY_MAX_TOKENS: u32 = 1_200;
const COMPACT_MESSAGE_PREVIEW_CHARS: usize = 2_000;
const COMPACT_TOOL_PREVIEW_CHARS: usize = 1_200;
const COMPACT_SHELL_CONTEXT_PREVIEW_CHARS: usize = 1_000;
const COMPACTION_CONTEXTS_DIR: &str = "ops_agent_context_summaries";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpsAgentCompactMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum StoredCompactionMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCompactionContext {
    conversation_id: String,
    mode: StoredCompactionMode,
    source_message_id: String,
    source_message_created_at: String,
    summarized_message_count: usize,
    kept_message_count: usize,
    summary: String,
    estimated_tokens_before: usize,
    estimated_tokens_after: usize,
    created_at: String,
}

struct CompactionSource {
    source_index: usize,
    message_id: String,
    message_created_at: String,
    summarized_visible_count: usize,
    kept_visible_count: usize,
}

pub async fn auto_compact_conversation_if_needed(
    state: &AppState,
    conversation_id: &str,
    session_id: Option<&str>,
    config: &AiConfig,
) -> AppResult<Option<OpsAgentCompactConversationResult>> {
    let conversation = state.ops_agent.get_conversation(conversation_id)?;
    let model_conversation =
        model_conversation_for_context(state, conversation.clone(), session_id, config)?;
    let log_context = OpsAgentLogContext::new(state, None, Some(conversation_id));
    let estimated_tokens =
        estimate_conversation_tokens(state, config, &model_conversation, session_id);
    log_context.append(
        "compact.auto.inspect",
        format!(
            "session_id={} visible_messages={} model_messages={} estimated_tokens={} max_context_tokens={}",
            session_id.unwrap_or("-"),
            conversation.messages.len(),
            model_conversation.messages.len(),
            estimated_tokens,
            config.max_context_tokens
        ),
    );
    if estimated_tokens <= config.max_context_tokens as usize {
        log_context.append(
            "compact.auto.skip",
            format!(
                "reason=within_context_limit estimated_tokens={} max_context_tokens={}",
                estimated_tokens, config.max_context_tokens
            ),
        );
        return Ok(None);
    }

    log_context.append(
        "compact.auto.triggered",
        format!(
            "estimated_tokens={} max_context_tokens={}",
            estimated_tokens, config.max_context_tokens
        ),
    );
    let result = compact_conversation_history(
        state,
        conversation,
        session_id,
        config,
        OpsAgentCompactMode::Auto,
    )
    .await?;
    Ok(Some(result))
}

pub fn model_conversation_for_current_message(
    state: &AppState,
    conversation: OpsAgentConversation,
    required_message_id: &str,
    session_id: Option<&str>,
    config: &AiConfig,
) -> AppResult<OpsAgentConversation> {
    let effective =
        model_conversation_for_context(state, conversation.clone(), session_id, config)?;
    if effective
        .messages
        .iter()
        .any(|message| message.id == required_message_id)
    {
        return Ok(effective);
    }

    let log_context = OpsAgentLogContext::new(state, None, Some(conversation.id.as_str()));
    log_context.append(
        "compact.model_context.skip_snapshot",
        format!(
            "reason=required_message_not_in_snapshot required_message_id={}",
            required_message_id
        ),
    );
    Ok(conversation)
}

pub fn model_conversation_for_context(
    state: &AppState,
    conversation: OpsAgentConversation,
    session_id: Option<&str>,
    config: &AiConfig,
) -> AppResult<OpsAgentConversation> {
    let Some(snapshot) = load_compaction_context(state, conversation.id.as_str())? else {
        return Ok(conversation);
    };

    let estimated_tokens = estimate_conversation_tokens(state, config, &conversation, session_id);
    if snapshot.mode == StoredCompactionMode::Auto
        && estimated_tokens <= config.max_context_tokens as usize
    {
        return Ok(conversation);
    }

    let Some(source_index) = conversation
        .messages
        .iter()
        .position(|message| message.id == snapshot.source_message_id)
    else {
        return Ok(conversation);
    };

    let mut model_messages = vec![
        private_compaction_boundary_message(&snapshot),
        private_compaction_summary_message(&snapshot),
    ];
    model_messages.extend(conversation.messages.iter().skip(source_index + 1).cloned());

    let log_context = OpsAgentLogContext::new(state, None, Some(conversation.id.as_str()));
    log_context.append(
        "compact.model_context.applied",
        format!(
            "mode={:?} summarized_messages={} kept_messages={} model_messages={} full_estimated_tokens={} snapshot_estimated_tokens_after={}",
            snapshot.mode,
            snapshot.summarized_message_count,
            snapshot.kept_message_count,
            model_messages.len(),
            estimated_tokens,
            snapshot.estimated_tokens_after
        ),
    );

    Ok(OpsAgentConversation {
        messages: model_messages,
        ..conversation
    })
}

pub async fn compact_conversation_history(
    state: &AppState,
    conversation: OpsAgentConversation,
    session_id: Option<&str>,
    config: &AiConfig,
    mode: OpsAgentCompactMode,
) -> AppResult<OpsAgentCompactConversationResult> {
    let previous_snapshot = load_compaction_context(state, conversation.id.as_str())?;
    let compactable_conversation =
        model_conversation_for_context(state, conversation.clone(), session_id, config)?;
    let estimated_tokens_before =
        estimate_conversation_tokens(state, config, &compactable_conversation, session_id);
    let log_context = OpsAgentLogContext::new(state, None, Some(conversation.id.as_str()));
    log_context.append(
        "compact.begin",
        format!(
            "mode={:?} session_id={} visible_messages={} model_messages={} previous_snapshot={} estimated_tokens_before={} max_context_tokens={}",
            mode,
            session_id
                .or(conversation.session_id.as_deref())
                .unwrap_or("-"),
            conversation.messages.len(),
            compactable_conversation.messages.len(),
            previous_snapshot.is_some(),
            estimated_tokens_before,
            config.max_context_tokens
        ),
    );

    if compactable_conversation.messages.len() < COMPACT_MIN_MESSAGES {
        log_context.append(
            "compact.skip",
            format!(
                "reason=too_few_messages messages={} threshold={}",
                compactable_conversation.messages.len(),
                COMPACT_MIN_MESSAGES
            ),
        );
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note: "The current conversation is still too short, so compaction is not needed yet."
                .to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    let keep_start = find_keep_start_index(
        &compactable_conversation.messages,
        config.max_context_tokens as usize,
    );
    if keep_start == 0 || keep_start >= compactable_conversation.messages.len() {
        log_context.append(
            "compact.skip",
            format!(
                "reason=keep_window_already_fits keep_start={} messages={}",
                keep_start,
                compactable_conversation.messages.len()
            ),
        );
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note: "The current conversation is still short enough, so there is no need to compact it right now.".to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    let messages_to_summarize = compactable_conversation.messages[..keep_start].to_vec();
    let messages_to_keep = compactable_conversation.messages[keep_start..].to_vec();
    if messages_to_summarize.is_empty() {
        log_context.append("compact.skip", "reason=no_messages_to_summarize");
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note: "The current conversation is still short enough, so there is no need to compact it right now.".to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }
    let Some(source) = resolve_compaction_source(
        &conversation,
        &messages_to_summarize,
        previous_snapshot.as_ref(),
    ) else {
        log_context.append(
            "compact.skip",
            "reason=no_visible_source_message_to_anchor_snapshot",
        );
        return Ok(OpsAgentCompactConversationResult {
            conversation,
            compacted: false,
            note:
                "There are no additional visible messages to fold into the model context summary."
                    .to_string(),
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    };

    let transcript = build_compaction_transcript(&messages_to_summarize);
    log_context.append(
        "compact.transcript_ready",
        format!(
            "keep_start={} summarize_messages={} keep_messages={} transcript_chars={}",
            keep_start,
            messages_to_summarize.len(),
            messages_to_keep.len(),
            transcript.chars().count()
        ),
    );
    let summary = match llm::compact_history_summary(
        config,
        &transcript,
        COMPACT_SUMMARY_MAX_TOKENS,
        Some(log_context),
    )
    .await
    {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            log_context.append(
                "compact.summary_ready",
                format!(
                    "source=ai summary_chars={} summary_preview={}",
                    trimmed.chars().count(),
                    truncate_for_log(trimmed.as_str(), COMPACT_MESSAGE_PREVIEW_CHARS)
                ),
            );
            trimmed
        }
        Err(error) => {
            let fallback = build_fallback_summary(&messages_to_summarize);
            log_context.append(
                "compact.summary_ready",
                format!(
                    "source=fallback error={} summary_chars={} summary_preview={}",
                    error,
                    fallback.chars().count(),
                    truncate_for_log(fallback.as_str(), COMPACT_MESSAGE_PREVIEW_CHARS)
                ),
            );
            fallback
        }
    };

    let snapshot_created_at = now_rfc3339();
    let snapshot_mode = match mode {
        OpsAgentCompactMode::Auto => StoredCompactionMode::Auto,
        OpsAgentCompactMode::Manual => StoredCompactionMode::Manual,
    };
    let snapshot_for_estimation = StoredCompactionContext {
        conversation_id: conversation.id.clone(),
        mode: snapshot_mode,
        source_message_id: source.message_id.clone(),
        source_message_created_at: source.message_created_at.clone(),
        summarized_message_count: source.summarized_visible_count,
        kept_message_count: source.kept_visible_count,
        summary: summary.trim().to_string(),
        estimated_tokens_before,
        estimated_tokens_after: estimated_tokens_before,
        created_at: snapshot_created_at.clone(),
    };
    let compacted_messages = [
        vec![
            private_compaction_boundary_message(&snapshot_for_estimation),
            private_compaction_summary_message(&snapshot_for_estimation),
        ],
        conversation
            .messages
            .iter()
            .skip(source.source_index + 1)
            .cloned()
            .collect::<Vec<_>>(),
    ]
    .concat();
    let estimated_tokens_after = estimate_messages_tokens(
        state,
        config,
        &compacted_messages,
        session_id,
        conversation.session_id.as_deref(),
    );
    let snapshot = StoredCompactionContext {
        estimated_tokens_after,
        ..snapshot_for_estimation
    };
    save_compaction_context(state, &snapshot)?;
    log_context.append(
        "compact.completed",
        format!(
            "mode={:?} summarized_messages={} kept_messages={} visible_messages={} estimated_tokens_before={} estimated_tokens_after={}",
            mode,
            source.summarized_visible_count,
            source.kept_visible_count,
            conversation.messages.len(),
            estimated_tokens_before,
            estimated_tokens_after
        ),
    );

    Ok(OpsAgentCompactConversationResult {
        conversation,
        compacted: true,
        note: match mode {
            OpsAgentCompactMode::Auto => {
                "Conversation model context was compacted automatically; visible chat history was preserved.".to_string()
            }
            OpsAgentCompactMode::Manual => {
                "Conversation model context was compacted; visible chat history was preserved."
                    .to_string()
            }
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
    estimate_messages_tokens(
        state,
        config,
        &conversation.messages,
        session_id,
        conversation.session_id.as_deref(),
    )
}

fn estimate_messages_tokens(
    state: &AppState,
    config: &AiConfig,
    messages: &[OpsAgentMessage],
    session_id: Option<&str>,
    conversation_session_id: Option<&str>,
) -> usize {
    let session_context = load_session_context(state, session_id.or(conversation_session_id));
    let tool_hints = state.ops_agent_tools.prompt_hints();
    let shell_execution_policy = match config.approval_mode {
        crate::models::AiApprovalMode::AutoExecute => {
            "The shell tool may auto-execute commands directly, including non-read-only commands."
        }
        crate::models::AiApprovalMode::RequireApproval => {
            "Read-only shell commands can run immediately; commands outside the safe read-only allowlist require user approval."
        }
    };
    let system_prompt = build_planner_system_prompt(
        &config.system_prompt,
        &session_context,
        &tool_hints,
        shell_execution_policy,
    );
    let messages_text = messages
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
            format!("{}. {}", index + 1, render_message_for_compaction(message))
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
    if !message.attachment_ids.is_empty() {
        base.push_str(format!("\nAttached images: {}", message.attachment_ids.len()).as_str());
    }
    base
}

fn render_message_for_compaction(message: &OpsAgentMessage) -> String {
    if is_private_compaction_boundary(message) {
        return "Existing private compaction boundary. This is metadata, not a user-visible event."
            .to_string();
    }
    if is_private_compaction_summary(message) {
        return format!(
            "Existing private context summary to merge and rewrite:\n{}",
            truncate_text(&message.content, COMPACT_MESSAGE_PREVIEW_CHARS)
        );
    }

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
    if !message.attachment_ids.is_empty() {
        text.push_str(format!("\nAttached images: {}", message.attachment_ids.len()).as_str());
    }

    text
}

fn build_fallback_summary(messages: &[OpsAgentMessage]) -> String {
    let mut bullets = Vec::new();
    bullets.push(
        "- The earlier conversation was compacted with a local fallback summary.".to_string(),
    );

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
                if message.role == OpsAgentRole::Tool {
                    180
                } else {
                    220
                }
            )
        ));
    }

    bullets.join("\n")
}

fn resolve_compaction_source(
    visible_conversation: &OpsAgentConversation,
    messages_to_summarize: &[OpsAgentMessage],
    previous_snapshot: Option<&StoredCompactionContext>,
) -> Option<CompactionSource> {
    for message in messages_to_summarize.iter().rev() {
        if is_private_compaction_message(message) {
            continue;
        }
        if let Some(source_index) = visible_conversation
            .messages
            .iter()
            .position(|item| item.id == message.id)
        {
            return Some(compaction_source_from_visible_index(
                visible_conversation,
                source_index,
            ));
        }
    }

    let previous = previous_snapshot?;
    let source_index = visible_conversation
        .messages
        .iter()
        .position(|item| item.id == previous.source_message_id)?;
    Some(compaction_source_from_visible_index(
        visible_conversation,
        source_index,
    ))
}

fn compaction_source_from_visible_index(
    visible_conversation: &OpsAgentConversation,
    source_index: usize,
) -> CompactionSource {
    let source_message = &visible_conversation.messages[source_index];
    let summarized_visible_count = source_index + 1;
    CompactionSource {
        source_index,
        message_id: source_message.id.clone(),
        message_created_at: source_message.created_at.clone(),
        summarized_visible_count,
        kept_visible_count: visible_conversation
            .messages
            .len()
            .saturating_sub(summarized_visible_count),
    }
}

fn is_private_compaction_message(message: &OpsAgentMessage) -> bool {
    is_private_compaction_boundary(message) || is_private_compaction_summary(message)
}

fn is_private_compaction_boundary(message: &OpsAgentMessage) -> bool {
    message.role == OpsAgentRole::System
        && message
            .content
            .starts_with("Private model context boundary:")
}

fn is_private_compaction_summary(message: &OpsAgentMessage) -> bool {
    message.role == OpsAgentRole::Assistant
        && message.content.starts_with("## Private Context Summary")
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

fn private_compaction_boundary_message(snapshot: &StoredCompactionContext) -> OpsAgentMessage {
    OpsAgentMessage {
        id: Uuid::new_v4().to_string(),
        role: OpsAgentRole::System,
        content: match snapshot.mode {
            StoredCompactionMode::Auto => {
                "Private model context boundary: older visible chat messages were summarized automatically for this AI request. The user-visible conversation history is unchanged.".to_string()
            }
            StoredCompactionMode::Manual => {
                "Private model context boundary: older visible chat messages were summarized manually for AI context. The user-visible conversation history is unchanged.".to_string()
            }
        },
        created_at: snapshot.created_at.clone(),
        tool_kind: None,
        shell_context: None,
        attachment_ids: Vec::new(),
    }
}

fn private_compaction_summary_message(snapshot: &StoredCompactionContext) -> OpsAgentMessage {
    OpsAgentMessage {
        id: Uuid::new_v4().to_string(),
        role: OpsAgentRole::Assistant,
        content: format!(
            "## Private Context Summary\n\nEarlier visible messages through `{}` were compressed for model context only.\n\n{}",
            snapshot.source_message_id,
            snapshot.summary.trim()
        ),
        created_at: snapshot.created_at.clone(),
        tool_kind: None,
        shell_context: None,
        attachment_ids: Vec::new(),
    }
}

fn save_compaction_context(state: &AppState, snapshot: &StoredCompactionContext) -> AppResult<()> {
    let path = compaction_context_path(state, snapshot.conversation_id.as_str());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_json_pretty(&path, snapshot)?;
    Ok(())
}

fn load_compaction_context(
    state: &AppState,
    conversation_id: &str,
) -> AppResult<Option<StoredCompactionContext>> {
    let path = compaction_context_path(state, conversation_id);
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn compaction_context_path(state: &AppState, conversation_id: &str) -> PathBuf {
    state
        .storage
        .data_dir()
        .join(COMPACTION_CONTEXTS_DIR)
        .join(format!("{}.json", sanitize_path_segment(conversation_id)))
}

fn sanitize_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn write_json_pretty<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let payload = serde_json::to_string_pretty(value)?;
    fs::write(path, payload)?;
    Ok(())
}
