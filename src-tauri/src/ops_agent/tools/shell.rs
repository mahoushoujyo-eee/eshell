use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::models::CommandExecutionResult;
use crate::ops_agent::logging::append_debug_log;
use crate::ops_agent::types::{OpsAgentActionStatus, OpsAgentRiskLevel, OpsAgentRole, OpsAgentToolKind};
use crate::ssh_service;

use super::{
    format_execution_output, OpsAgentTool, OpsAgentToolDefinition, OpsAgentToolExecution,
    OpsAgentToolOutcome, OpsAgentToolRequest, OpsAgentToolResolution, OpsAgentToolResolveRequest,
    ToolFuture,
};

const READ_ONLY_ROOT_COMMANDS: &[&str] = &[
    "ls",
    "cat",
    "grep",
    "egrep",
    "fgrep",
    "head",
    "tail",
    "find",
    "pwd",
    "whoami",
    "id",
    "uname",
    "hostname",
    "date",
    "df",
    "du",
    "free",
    "ps",
    "top",
    "uptime",
    "w",
    "who",
    "last",
    "env",
    "printenv",
    "which",
    "whereis",
    "type",
    "stat",
    "file",
    "ss",
    "netstat",
    "lsof",
    "journalctl",
    "ip",
    "ifconfig",
    "vmstat",
    "iostat",
    "dmesg",
    "awk",
    "sed",
    "cut",
    "sort",
    "uniq",
    "wc",
];

const READ_ONLY_SYSTEMCTL_ACTIONS: &[&str] = &[
    "status",
    "is-active",
    "is-enabled",
    "list-units",
    "list-unit-files",
    "list-timers",
    "show",
    "cat",
];

const READ_ONLY_GIT_ACTIONS: &[&str] = &[
    "status",
    "log",
    "show",
    "diff",
    "branch",
    "rev-parse",
    "remote",
    "tag",
    "blame",
];

const READ_ONLY_DOCKER_ACTIONS: &[&str] = &[
    "ps",
    "images",
    "inspect",
    "logs",
    "stats",
    "version",
    "info",
    "events",
];

const READ_ONLY_KUBECTL_ACTIONS: &[&str] = &[
    "get",
    "describe",
    "logs",
    "top",
    "cluster-info",
    "version",
    "api-resources",
    "api-versions",
    "config",
];

const MUTATING_ROOT_COMMANDS: &[&str] = &[
    "rm",
    "mv",
    "cp",
    "touch",
    "mkdir",
    "rmdir",
    "chmod",
    "chown",
    "chgrp",
    "ln",
    "tee",
    "dd",
    "mkfs",
    "fdisk",
    "mount",
    "umount",
    "shutdown",
    "reboot",
    "poweroff",
    "init",
    "halt",
    "apt",
    "apt-get",
    "yum",
    "dnf",
    "pacman",
];

const HIGH_RISK_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf *",
    "mkfs",
    "dd if=",
    "shutdown",
    "poweroff",
    "reboot",
    "init 0",
    "halt",
    "chmod 777 /",
];

const MEDIUM_RISK_PATTERNS: &[&str] = &[
    "systemctl restart",
    "systemctl stop",
    "systemctl start",
    "systemctl reload",
    "service restart",
    "service stop",
    "service start",
    "docker rm",
    "docker stop",
    "docker restart",
    "kubectl apply",
    "kubectl delete",
    "git reset",
    "git clean",
    "git rebase",
    "git merge",
    "git commit",
    "git push",
    "git pull",
];

/// Unified shell tool:
/// - Read-only commands execute immediately.
/// - Blocked/mutating commands are converted to approval-required pending actions.
pub struct ShellTool;

/// Reads shell context payload attached by frontend UI in the latest user message.
pub struct UiContextTool;

impl OpsAgentTool for ShellTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::shell(),
            description: "Execute shell commands. Read-only diagnostics run immediately; mutating or blocked commands require approval."
                .to_string(),
            usage_notes: vec![
                "Prefer read-only diagnostics first (ls, cat, grep, df, free, ps, top, uptime)."
                    .to_string(),
                "If command is blocked by read-only policy, the tool will queue an approval action instead of failing."
                    .to_string(),
            ],
            requires_approval: false,
        }
    }

    fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> ToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let conversation_id = request.conversation_id.clone();
            let session_id = request.session_id.ok_or_else(|| {
                AppError::Validation("shell tool requires an active SSH session".to_string())
            })?;
            let raw_command = request.command.trim().to_string();
            let reason = request.reason.unwrap_or_else(|| "planner did not provide reason".to_string());

            if raw_command.is_empty() {
                return Err(AppError::Validation("shell command cannot be empty".to_string()));
            }

            append_debug_log(
                request.state.as_ref(),
                "shell.request",
                None,
                Some(conversation_id.as_str()),
                format!("session_id={session_id} command={raw_command} reason={reason}"),
            );

            let validated = match validate_read_shell_command(&raw_command) {
                Ok(command) => command,
                Err(error) => {
                    append_debug_log(
                        request.state.as_ref(),
                        "shell.read_policy_rejected",
                        None,
                        Some(conversation_id.as_str()),
                        format!("command={raw_command} error={error}"),
                    );

                    if should_request_approval_after_read_rejection(&error) {
                        let risk_level = classify_write_shell_risk(&raw_command);
                        let reason = format!(
                            "Blocked by read-only policy: {error}. Waiting for explicit approval."
                        );
                        let action = request.state.ops_agent.create_pending_action(
                            &conversation_id,
                            Some(session_id.as_str()),
                            OpsAgentToolKind::shell(),
                            risk_level,
                            &raw_command,
                            &reason,
                        )?;

                        append_debug_log(
                            request.state.as_ref(),
                            "shell.escalated_for_approval",
                            None,
                            Some(conversation_id.as_str()),
                            format!(
                                "action_id={} risk={} command={}",
                                action.id,
                                risk_level_label(&action.risk_level),
                                action.command
                            ),
                        );
                        return Ok(OpsAgentToolOutcome::AwaitingApproval(action));
                    }

                    return Err(error);
                }
            };

            let execution =
                execute_remote_command(request.state.clone(), session_id, validated.clone()).await?;
            let output = format_execution_output(&execution.stdout, &execution.stderr, execution.exit_code);

            append_debug_log(
                request.state.as_ref(),
                "shell.executed",
                None,
                Some(conversation_id.as_str()),
                format!(
                    "command={validated} exit_code={} output_chars={}",
                    execution.exit_code,
                    output.len()
                ),
            );

            Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                tool_kind: OpsAgentToolKind::shell(),
                command: validated.clone(),
                output: output.clone(),
                exit_code: Some(execution.exit_code),
                message: format!(
                    "shell executed.\nCommand: {validated}\nExit: {}\n{output}",
                    execution.exit_code
                ),
                stream_label: Some(format!("shell: {validated}")),
            }))
        })
    }

    fn resolve_action(
        self: Arc<Self>,
        request: OpsAgentToolResolveRequest,
    ) -> ToolFuture<OpsAgentToolResolution> {
        let _ = self;
        Box::pin(async move {
            let action = request.action;
            if action.status != OpsAgentActionStatus::Pending {
                return Err(AppError::Validation(
                    "action is not pending and cannot be resolved again".to_string(),
                ));
            }

            let Some(session_id) = action.session_id.clone() else {
                let updated = request.state.ops_agent.mark_action_failed(
                    &action.id,
                    "missing session id for shell action".to_string(),
                )?;
                append_debug_log(
                    request.state.as_ref(),
                    "shell.approval_failed",
                    None,
                    Some(updated.conversation_id.as_str()),
                    format!("action_id={} command={} reason=missing_session_id", updated.id, updated.command),
                );
                return Ok(OpsAgentToolResolution {
                    message: format!(
                        "shell action failed.\nCommand: {}\nReason: missing session id.",
                        updated.command
                    ),
                    action: updated,
                });
            };

            let command = action.command.clone();
            let execution = execute_remote_command(request.state.clone(), session_id, command.clone()).await;
            match execution {
                Ok(execution) => {
                    let output =
                        format_execution_output(&execution.stdout, &execution.stderr, execution.exit_code);
                    let updated = request.state.ops_agent.mark_action_executed(
                        &action.id,
                        output.clone(),
                        execution.exit_code,
                    )?;
                    append_debug_log(
                        request.state.as_ref(),
                        "shell.approval_executed",
                        None,
                        Some(updated.conversation_id.as_str()),
                        format!(
                            "action_id={} risk={} command={} exit_code={}",
                            updated.id,
                            risk_level_label(&updated.risk_level),
                            command,
                            execution.exit_code
                        ),
                    );
                    Ok(OpsAgentToolResolution {
                        message: format!(
                            "shell action executed.\nRisk: {}\nCommand: {command}\nExit: {}\n{output}",
                            risk_level_label(&updated.risk_level),
                            execution.exit_code
                        ),
                        action: updated,
                    })
                }
                Err(error) => {
                    let updated = request
                        .state
                        .ops_agent
                        .mark_action_failed(&action.id, error.to_string())?;
                    append_debug_log(
                        request.state.as_ref(),
                        "shell.approval_failed",
                        None,
                        Some(updated.conversation_id.as_str()),
                        format!(
                            "action_id={} risk={} command={} error={}",
                            updated.id,
                            risk_level_label(&updated.risk_level),
                            command,
                            error
                        ),
                    );
                    Ok(OpsAgentToolResolution {
                        message: format!(
                            "shell action failed.\nRisk: {}\nCommand: {command}\nError: {error}",
                            risk_level_label(&updated.risk_level),
                        ),
                        action: updated,
                    })
                }
            }
        })
    }
}

impl OpsAgentTool for UiContextTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::ui_context(),
            description:
                "Read frontend UI context attached by the user (for example selected shell output snippet)."
                    .to_string(),
            usage_notes: vec![
                "Use when you need exact text the user attached from UI.".to_string(),
                "Command argument is optional and ignored.".to_string(),
            ],
            requires_approval: false,
        }
    }

    fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> ToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let conversation = request
                .state
                .ops_agent
                .get_conversation(&request.conversation_id)?;
            let context_message = conversation
                .messages
                .iter()
                .rev()
                .find(|item| item.role == OpsAgentRole::User)
                .and_then(|item| item.shell_context.as_ref());

            let output = if let Some(context) = context_message {
                format!(
                    "UI shell context is available.\nsessionName: {}\ncharCount: {}\npreview: {}\n\ncontent:\n{}",
                    context.session_name, context.char_count, context.preview, context.content
                )
            } else {
                "No UI shell context was attached by the user in this conversation.".to_string()
            };

            append_debug_log(
                request.state.as_ref(),
                "ui_context.read",
                None,
                Some(request.conversation_id.as_str()),
                format!("found_context={}", context_message.is_some()),
            );

            Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                tool_kind: OpsAgentToolKind::ui_context(),
                command: request.command.trim().to_string(),
                output: output.clone(),
                exit_code: None,
                message: format!("ui_context read.\n{output}"),
                stream_label: Some("ui_context".to_string()),
            }))
        })
    }
}

async fn execute_remote_command(
    state: Arc<crate::state::AppState>,
    session_id: String,
    command: String,
) -> AppResult<CommandExecutionResult> {
    tauri::async_runtime::spawn_blocking(move || ssh_service::execute_command(&state, &session_id, &command))
        .await
        .map_err(|error| AppError::Runtime(error.to_string()))?
}

fn validate_read_shell_command(command: &str) -> AppResult<String> {
    let normalized = command.trim().to_string();
    if normalized.is_empty() {
        return Err(AppError::Validation(
            "read_shell command cannot be empty".to_string(),
        ));
    }

    if normalized.contains('\n')
        || normalized.contains('\r')
        || normalized.contains(';')
        || normalized.contains("&&")
        || normalized.contains("||")
    {
        return Err(AppError::Validation(
            "read_shell does not allow command chaining".to_string(),
        ));
    }

    if normalized.contains('>')
        || normalized.contains(">>")
        || normalized.contains('<')
        || normalized.contains("`")
        || normalized.contains("$(")
    {
        return Err(AppError::Validation(
            "read_shell command contains unsupported shell redirection or substitution".to_string(),
        ));
    }

    for segment in normalized.split('|') {
        validate_read_shell_segment(segment.trim())?;
    }

    Ok(normalized)
}

fn validate_read_shell_segment(segment: &str) -> AppResult<()> {
    if segment.is_empty() {
        return Err(AppError::Validation(
            "read_shell command contains an empty pipeline segment".to_string(),
        ));
    }

    let tokens = segment
        .split_whitespace()
        .map(|item| item.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return Err(AppError::Validation(
            "read_shell command is missing a root command".to_string(),
        ));
    }

    let root = tokens[0].as_str();
    if MUTATING_ROOT_COMMANDS.contains(&root) {
        return Err(AppError::Validation(format!(
            "read_shell rejected mutating root command `{root}`"
        )));
    }

    match root {
        "systemctl" => validate_subcommand_allowlist(
            root,
            &tokens,
            READ_ONLY_SYSTEMCTL_ACTIONS,
            "status/is-active/list operations",
        ),
        "service" => validate_service_status_only(&tokens),
        "git" => validate_subcommand_allowlist(
            root,
            &tokens,
            READ_ONLY_GIT_ACTIONS,
            "status/log/show/diff/branch queries",
        ),
        "docker" => validate_subcommand_allowlist(
            root,
            &tokens,
            READ_ONLY_DOCKER_ACTIONS,
            "ps/images/inspect/logs/stats/info queries",
        ),
        "kubectl" => validate_subcommand_allowlist(
            root,
            &tokens,
            READ_ONLY_KUBECTL_ACTIONS,
            "get/describe/logs/top/version style queries",
        ),
        "sed" => {
            if tokens
                .iter()
                .any(|item| item == "-i" || item.starts_with("-i") || item == "--in-place")
            {
                return Err(AppError::Validation(
                    "read_shell rejected `sed -i` because it mutates files".to_string(),
                ));
            }
            Ok(())
        }
        _ => {
            if READ_ONLY_ROOT_COMMANDS.contains(&root) {
                Ok(())
            } else {
                Err(AppError::Validation(format!(
                    "read_shell command `{root}` is not in the allowlist"
                )))
            }
        }
    }
}

fn validate_subcommand_allowlist(
    root: &str,
    tokens: &[String],
    allowlist: &[&str],
    hint: &str,
) -> AppResult<()> {
    let action = first_non_flag_token(tokens, 1).unwrap_or("");
    if action.is_empty() || allowlist.contains(&action) {
        return Ok(());
    }

    Err(AppError::Validation(format!(
        "read_shell rejected `{root} {action}`; only {hint} are allowed"
    )))
}

fn validate_service_status_only(tokens: &[String]) -> AppResult<()> {
    let action = if tokens.len() >= 3 {
        tokens[2].as_str()
    } else {
        first_non_flag_token(tokens, 1).unwrap_or("")
    };

    if action.is_empty() || action == "status" || action == "--status-all" {
        return Ok(());
    }

    Err(AppError::Validation(format!(
        "read_shell rejected `service {action}`; only status checks are allowed"
    )))
}

fn first_non_flag_token(tokens: &[String], start: usize) -> Option<&str> {
    tokens
        .iter()
        .skip(start)
        .find(|item| !item.starts_with('-'))
        .map(|item| item.as_str())
}

fn should_request_approval_after_read_rejection(error: &AppError) -> bool {
    let AppError::Validation(message) = error else {
        return false;
    };

    let normalized = message.to_ascii_lowercase();
    if normalized.contains("command chaining")
        || normalized.contains("redirection")
        || normalized.contains("substitution")
        || normalized.contains("empty pipeline segment")
        || normalized.contains("missing a root command")
        || normalized.contains("cannot be empty")
    {
        return false;
    }

    normalized.contains("not in the allowlist")
        || normalized.contains("rejected mutating root command")
        || normalized.contains("only")
        || normalized.contains("sed -i")
}

fn classify_write_shell_risk(command: &str) -> OpsAgentRiskLevel {
    let normalized = command.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return OpsAgentRiskLevel::Low;
    }

    if HIGH_RISK_PATTERNS
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        return OpsAgentRiskLevel::High;
    }
    if MEDIUM_RISK_PATTERNS
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        return OpsAgentRiskLevel::Medium;
    }
    if normalized.contains("rm -rf") || normalized.contains("mkfs") {
        return OpsAgentRiskLevel::High;
    }
    if normalized.contains("systemctl ") || normalized.contains("service ") {
        return OpsAgentRiskLevel::Medium;
    }

    OpsAgentRiskLevel::Low
}

fn risk_level_label(level: &OpsAgentRiskLevel) -> &'static str {
    match level {
        OpsAgentRiskLevel::Low => "low",
        OpsAgentRiskLevel::Medium => "medium",
        OpsAgentRiskLevel::High => "high",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_read_shell_allows_safe_pipelines() {
        let command = validate_read_shell_command("ps aux | grep nginx | wc -l")
            .expect("validate read command");
        assert_eq!(command, "ps aux | grep nginx | wc -l");
    }

    #[test]
    fn validate_read_shell_rejects_mutation_and_chaining() {
        let command = validate_read_shell_command("rm -rf /tmp/foo");
        assert!(command.is_err());

        let chained = validate_read_shell_command("ls && systemctl restart nginx");
        assert!(chained.is_err());
    }

    #[test]
    fn read_rejection_can_be_escalated_to_approval() {
        let blocked = validate_read_shell_command("java -version").expect_err("blocked");
        assert!(should_request_approval_after_read_rejection(&blocked));

        let invalid = validate_read_shell_command("ls > out.txt").expect_err("invalid");
        assert!(!should_request_approval_after_read_rejection(&invalid));
    }

    #[test]
    fn classify_write_risk_matches_common_operations() {
        assert_eq!(
            classify_write_shell_risk("systemctl restart nginx"),
            OpsAgentRiskLevel::Medium
        );
        assert_eq!(
            classify_write_shell_risk("rm -rf /var/www"),
            OpsAgentRiskLevel::High
        );
        assert_eq!(
            classify_write_shell_risk("echo hello > /tmp/ok.txt"),
            OpsAgentRiskLevel::Low
        );
    }
}
