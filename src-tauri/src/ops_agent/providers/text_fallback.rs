use std::collections::HashSet;

use serde::Deserialize;

use crate::error::AppResult;
use crate::ops_agent::context::OpsAgentToolPromptHint;
use crate::ops_agent::types::{OpsAgentToolKind, PlannedAgentReply, PlannedToolAction};

use super::normalize_tool_kind_alias;

const MINIMAX_TOOL_CALL_START: &str = "<minimax:tool_call";
const MINIMAX_TOOL_CALL_END: &str = "</minimax:tool_call>";
const INVOKE_START: &str = "<invoke";
const INVOKE_END: &str = "</invoke>";

#[derive(Debug, Deserialize)]
struct PlanPayload {
    reply: Option<String>,
    tool: Option<PlanToolPayload>,
}

#[derive(Debug, Deserialize)]
struct PlanToolPayload {
    kind: Option<String>,
    command: Option<String>,
    reason: Option<String>,
}

pub fn parse_planned_reply(
    raw: &str,
    tool_hints: &[OpsAgentToolPromptHint],
) -> AppResult<PlannedAgentReply> {
    let registered = tool_hints
        .iter()
        .map(|item| item.kind.to_string())
        .collect::<HashSet<_>>();
    if let Some(plan) = parse_structured_plan_payload(raw, &registered, true) {
        return Ok(plan);
    }

    if let Some(plan) = parse_markup_tool_call(raw, &registered) {
        return Ok(plan);
    }

    Ok(PlannedAgentReply {
        reply: sanitize_planner_reply(raw),
        tool: PlannedToolAction {
            kind: OpsAgentToolKind::none(),
            command: None,
            reason: None,
        },
    })
}

fn normalize_planned_reply(
    payload: PlanPayload,
    registered_tools: &HashSet<String>,
) -> PlannedAgentReply {
    let reply = payload.reply.unwrap_or_default().trim().to_string();
    let tool = payload.tool.unwrap_or(PlanToolPayload {
        kind: Some("none".to_string()),
        command: None,
        reason: None,
    });

    let requested_kind = normalize_tool_kind_alias(
        OpsAgentToolKind::new(tool.kind.unwrap_or_default()),
        registered_tools,
    );
    let kind = if requested_kind.is_none() || registered_tools.contains(requested_kind.as_str()) {
        requested_kind
    } else {
        OpsAgentToolKind::none()
    };

    let command = tool.command.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    let normalized_kind = if command.is_none() {
        OpsAgentToolKind::none()
    } else {
        kind
    };
    let normalized_command = if normalized_kind.is_none() {
        None
    } else {
        command
    };

    PlannedAgentReply {
        reply: sanitize_planner_reply(reply.as_str()),
        tool: PlannedToolAction {
            kind: normalized_kind,
            command: normalized_command,
            reason: tool.reason.map(|item| item.trim().to_string()),
        },
    }
}

fn parse_structured_plan_payload(
    raw: &str,
    registered_tools: &HashSet<String>,
    allow_nested_reply_payload: bool,
) -> Option<PlannedAgentReply> {
    for candidate in iter_plan_payload_candidates(raw) {
        if let Ok(payload) = serde_json::from_str::<PlanPayload>(&candidate) {
            let normalized = normalize_planned_reply(payload, registered_tools);
            if allow_nested_reply_payload && normalized.tool.kind.is_none() {
                if let Some(nested) = parse_structured_plan_payload(
                    normalized.reply.as_str(),
                    registered_tools,
                    false,
                )
                .or_else(|| parse_markup_tool_call(normalized.reply.as_str(), registered_tools))
                {
                    if !nested.tool.kind.is_none() || !nested.reply.trim().is_empty() {
                        return Some(nested);
                    }
                }
            }
            return Some(normalized);
        }
    }

    None
}

fn parse_markup_tool_call(
    raw: &str,
    registered_tools: &HashSet<String>,
) -> Option<PlannedAgentReply> {
    let tool_name = extract_invoke_tool_name(raw)?;
    let command = extract_tag_value(raw, "command")?;
    let kind = normalize_tool_kind_alias(OpsAgentToolKind::new(tool_name), registered_tools);
    if kind.is_none() || !registered_tools.contains(kind.as_str()) {
        return None;
    }

    Some(PlannedAgentReply {
        reply: sanitize_planner_reply(raw),
        tool: PlannedToolAction {
            kind,
            command: Some(command),
            reason: extract_parameter_value(raw, "reason")
                .or_else(|| extract_tag_value(raw, "reason")),
        },
    })
}

pub fn sanitize_planner_reply(raw: &str) -> String {
    let mut text = strip_balanced_block(raw.trim(), MINIMAX_TOOL_CALL_START, MINIMAX_TOOL_CALL_END);
    text = strip_balanced_block(text.as_str(), INVOKE_START, INVOKE_END);
    text = text.replace("</intent>", "").replace("<intent>", "");
    text.trim().to_string()
}

fn strip_balanced_block(raw: &str, start_marker: &str, end_marker: &str) -> String {
    let mut remaining = raw.to_string();
    while let Some(start) = remaining.find(start_marker) {
        let end = remaining[start..]
            .find(end_marker)
            .map(|offset| start + offset + end_marker.len())
            .unwrap_or_else(|| remaining.len());
        remaining.replace_range(start..end, "");
    }
    remaining
}

fn extract_invoke_tool_name(raw: &str) -> Option<String> {
    let start = raw.find(INVOKE_START)?;
    let end = raw[start..].find('>')? + start;
    let header = &raw[start..=end];
    extract_attribute_value(header, "name").or_else(|| extract_attribute_value(header, "tool"))
}

fn extract_attribute_value(raw: &str, attribute: &str) -> Option<String> {
    for quote in [r#"""#, "'"] {
        let needle = format!("{attribute}={quote}");
        if let Some(start) = raw.find(&needle) {
            let value_start = start + needle.len();
            if let Some(value_end) = raw[value_start..].find(quote) {
                let value = raw[value_start..value_start + value_end].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn extract_tag_value(raw: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = raw.find(&open)?;
    let open_end = raw[start..].find('>')? + start;
    let content_start = open_end + 1;

    let close_tag = format!("</{tag}>");
    let remainder = &raw[content_start..];
    let mut end_candidates = Vec::new();
    if let Some(offset) = remainder.find(&close_tag) {
        end_candidates.push(content_start + offset);
    }
    for marker in ["<parameter", "<reason", INVOKE_END, MINIMAX_TOOL_CALL_END] {
        if let Some(offset) = remainder.find(marker) {
            end_candidates.push(content_start + offset);
        }
    }

    let end = end_candidates.into_iter().min()?;
    let value = raw[content_start..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn extract_parameter_value(raw: &str, parameter_name: &str) -> Option<String> {
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let Some(offset) = raw[cursor..].find("<parameter") else {
            break;
        };
        let start = cursor + offset;
        let open_end = raw[start..].find('>')? + start;
        let header = &raw[start..=open_end];
        let name = extract_attribute_value(header, "name");
        cursor = open_end + 1;
        if name.as_deref() != Some(parameter_name) {
            continue;
        }

        let close = "</parameter>";
        let end = raw[cursor..].find(close)? + cursor;
        let value = raw[cursor..end].trim();
        if value.is_empty() {
            return None;
        }
        return Some(value.to_string());
    }

    None
}

fn iter_plan_payload_candidates(raw: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        candidates.push(trimmed.to_string());
    }

    for object in extract_json_objects(trimmed) {
        if !candidates.iter().any(|item| item == &object) {
            candidates.push(object);
        }
    }

    candidates
}

fn extract_json_objects(raw: &str) -> Vec<String> {
    let mut rows = Vec::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let Some(offset) = raw[cursor..].find('{') else {
            break;
        };
        let start = cursor + offset;
        if let Some(end) = find_balanced_json_object_end(raw, start) {
            if end >= start {
                rows.push(raw[start..=end].to_string());
                cursor = end + 1;
                continue;
            }
        }
        cursor = start + 1;
    }
    rows
}

fn find_balanced_json_object_end(raw: &str, start: usize) -> Option<usize> {
    if raw.get(start..=start)? != "{" {
        return None;
    }

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (relative_index, ch) in raw[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                if depth == 0 {
                    return Some(start + relative_index);
                }
            }
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_hint() -> OpsAgentToolPromptHint {
        OpsAgentToolPromptHint {
            kind: OpsAgentToolKind::shell(),
            description: "shell".to_string(),
            usage_notes: Vec::new(),
            requires_approval: false,
        }
    }

    #[test]
    fn parses_json_plan_payload() {
        let payload = parse_planned_reply(
            r#"{"reply":"check","tool":{"kind":"read_shell","command":"df -h","reason":"inspect"}}"#,
            &[shell_hint()],
        )
        .expect("parse plan");

        assert_eq!(payload.tool.kind, OpsAgentToolKind::shell());
        assert_eq!(payload.tool.command.as_deref(), Some("df -h"));
    }

    #[test]
    fn parses_markup_tool_call_payload() {
        let payload = parse_planned_reply(
            r#"<minimax:tool_call>
<invoke name="shell">
<command">ls -la /tmp</command>
<parameter name="reason">查看目录</parameter>
</invoke>
</minimax:tool_call>"#,
            &[shell_hint()],
        )
        .expect("parse markup plan");

        assert_eq!(payload.tool.kind, OpsAgentToolKind::shell());
        assert_eq!(payload.tool.command.as_deref(), Some("ls -la /tmp"));
        assert_eq!(payload.tool.reason.as_deref(), Some("查看目录"));
    }

    #[test]
    fn strips_markup_from_plain_reply_fallback() {
        let payload = parse_planned_reply(
            "先检查一下。\n<minimax:tool_call>\n<invoke name=\"unknown_tool\">\n<command\">do something</command>\n</invoke>\n</minimax:tool_call>",
            &[shell_hint()],
        )
        .expect("parse fallback reply");

        assert!(payload.tool.kind.is_none());
        assert_eq!(payload.reply, "先检查一下。");
    }
}
