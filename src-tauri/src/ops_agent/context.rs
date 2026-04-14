use crate::models::ShellSession;
use crate::state::AppState;

use super::types::OpsAgentToolKind;

const LAST_OUTPUT_PREVIEW_CHARS: usize = 240;

/// Prompt-safe description of the active shell session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpsAgentSessionContext {
    pub session_id: Option<String>,
    pub current_dir: Option<String>,
    pub last_output_preview: Option<String>,
}

/// Planner-facing tool metadata derived from the runtime registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpsAgentToolPromptHint {
    pub kind: OpsAgentToolKind,
    pub description: String,
    pub usage_notes: Vec<String>,
    pub requires_approval: bool,
}

impl OpsAgentSessionContext {
    /// Renders session context in a compact format suitable for LLM prompts.
    pub fn to_prompt_block(&self) -> String {
        let mut rows = Vec::new();
        rows.push(format!(
            "Current SSH session id: {}",
            self.session_id.as_deref().unwrap_or("unavailable")
        ));
        rows.push(format!(
            "Current working directory: {}",
            self.current_dir.as_deref().unwrap_or("unknown")
        ));

        if let Some(last_output_preview) = &self.last_output_preview {
            rows.push(format!(
                "Recent terminal output preview:\n{last_output_preview}"
            ));
        }

        rows.join("\n")
    }
}

/// Loads shell session metadata once so prompt construction is centralized.
pub fn load_session_context(state: &AppState, session_id: Option<&str>) -> OpsAgentSessionContext {
    let Some(session_id) = session_id else {
        return OpsAgentSessionContext::default();
    };

    let Ok(session) = state.get_session(session_id) else {
        return OpsAgentSessionContext {
            session_id: Some(session_id.to_string()),
            ..OpsAgentSessionContext::default()
        };
    };

    build_session_context(Some(session))
}

/// Builds the planner prompt using the runtime tool catalog instead of hard-coded text.
pub fn build_planner_system_prompt(
    base_prompt: &str,
    session_context: &OpsAgentSessionContext,
    tool_hints: &[OpsAgentToolPromptHint],
    shell_execution_policy: &str,
) -> String {
    format!(
        "{base}\n\nYou are an operations ReAct planner. Decide the next best action at each step.\n\
Registered tools:\n\
{tool_block}\n\
Session context:\n\
{session_block}\n\
Rules:\n\
1) Treat this as a loop: pick one tool action, observe result, then you will be asked again.\n\
2) Use native tool calling when you need a tool. Do not serialize tool invocations into text.\n\
3) Call at most one tool per turn.\n\
4) If evidence is already sufficient, answer directly in plain text without any tool call.\n\
5) Keep any direct textual reply concise and user-facing.\n\
6) Choose a registered tool name exactly as documented above.\n\
7) Shell execution policy: {shell_execution_policy}",
        base = base_prompt.trim(),
        tool_block = format_tool_catalog(tool_hints),
        session_block = session_context.to_prompt_block(),
        shell_execution_policy = shell_execution_policy,
    )
}

/// Builds a dedicated answer prompt used for real-time streaming responses.
pub fn build_answer_system_prompt(
    base_prompt: &str,
    session_context: &OpsAgentSessionContext,
    planner_reply: Option<&str>,
) -> String {
    let planner_hint = planner_reply
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("Planner draft:\n{value}\n"))
        .unwrap_or_default();

    format!(
        "{base}\n\nYou are the final operations assistant response writer.\n\
Provide a concise markdown answer that directly helps the user.\n\
Prefer evidence-based statements, highlight uncertainty, and keep next steps safe.\n\
{planner_hint}Session context:\n\
{session_block}",
        base = base_prompt.trim(),
        session_block = session_context.to_prompt_block(),
    )
}

/// Builds the summary prompt after a tool has produced output.
#[allow(dead_code)]
pub fn build_tool_summary_prompt(
    base_prompt: &str,
    session_context: &OpsAgentSessionContext,
) -> String {
    format!(
        "{base}\n\nGiven shell tool execution results, provide a concise markdown answer.\n\
Include: what happened, the most relevant evidence, and a safe next step when useful.\n\
Session context:\n\
{session_block}",
        base = base_prompt.trim(),
        session_block = session_context.to_prompt_block(),
    )
}

/// Formats tool execution details as a user message for the summarizer.
#[allow(dead_code)]
pub fn format_tool_result_user_message(
    tool_kind: &OpsAgentToolKind,
    command: &str,
    output: &str,
    exit_code: Option<i32>,
) -> String {
    format!(
        "Tool execution result\nkind: {tool_kind}\ncommand: {command}\nexitCode: {exit_code}\noutput:\n{output}",
        exit_code = exit_code
            .map(|item| item.to_string())
            .unwrap_or_else(|| "n/a".to_string()),
    )
}

fn build_session_context(session: Option<ShellSession>) -> OpsAgentSessionContext {
    let Some(session) = session else {
        return OpsAgentSessionContext::default();
    };

    OpsAgentSessionContext {
        session_id: Some(session.id),
        current_dir: Some(session.current_dir),
        last_output_preview: build_last_output_preview(&session.last_output),
    }
}

fn format_tool_catalog(tool_hints: &[OpsAgentToolPromptHint]) -> String {
    if tool_hints.is_empty() {
        return "- none: No registered tools are available.".to_string();
    }

    tool_hints
        .iter()
        .map(|item| {
            let approval = if item.requires_approval {
                "requires approval"
            } else {
                "no approval"
            };
            let notes = if item.usage_notes.is_empty() {
                String::new()
            } else {
                format!(" Notes: {}", item.usage_notes.join(" "))
            };
            format!(
                "- {}: {} ({approval}).{}",
                item.kind,
                item.description.trim(),
                notes
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_last_output_preview(value: &str) -> Option<String> {
    let compact = value.trim();
    if compact.is_empty() {
        return None;
    }

    let mut preview = compact
        .chars()
        .take(LAST_OUTPUT_PREVIEW_CHARS)
        .collect::<String>();
    if compact.chars().count() > LAST_OUTPUT_PREVIEW_CHARS {
        preview.push_str("...");
    }
    Some(preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_prompt_uses_registered_tools() {
        let prompt = build_planner_system_prompt(
            "Base prompt",
            &OpsAgentSessionContext::default(),
            &[
                OpsAgentToolPromptHint {
                    kind: OpsAgentToolKind::shell(),
                    description: "Unified shell command execution.".to_string(),
                    usage_notes: vec![
                        "Read-only runs immediately; writes require approval.".to_string()
                    ],
                    requires_approval: false,
                },
                OpsAgentToolPromptHint {
                    kind: OpsAgentToolKind::ui_context(),
                    description: "Read UI-attached shell context.".to_string(),
                    usage_notes: vec!["Use when user attached terminal snippets.".to_string()],
                    requires_approval: false,
                },
            ],
            "Read-only runs immediately; writes require approval.",
        );

        assert!(prompt.contains("shell"));
        assert!(prompt.contains("ui_context"));
        assert!(prompt.contains("no approval"));
    }

    #[test]
    fn tool_result_message_contains_exit_code() {
        let payload = format_tool_result_user_message(
            &OpsAgentToolKind::shell(),
            "df -h",
            "stdout:\n/dev/root",
            Some(0),
        );

        assert!(payload.contains("kind: shell"));
        assert!(payload.contains("exitCode: 0"));
    }
}
