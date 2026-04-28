use std::env;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use crate::ops_agent::core::helpers::normalized_reply;
use crate::ops_agent::domain::types::{
    OpsAgentActionStatus, OpsAgentMessage, OpsAgentPendingAction, OpsAgentResolveActionInput,
    OpsAgentRiskLevel, OpsAgentRole, OpsAgentToolKind,
};
use crate::ops_agent::tools::{
    OpsAgentTool, OpsAgentToolDefinition, OpsAgentToolExecution, OpsAgentToolOutcome,
    OpsAgentToolRegistry, OpsAgentToolRequest, OpsAgentToolResolution, OpsAgentToolResolveRequest,
};
use crate::state::AppState;

use super::resolve_pending_action;

type TestToolFuture<T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'static>>;
const MOCK_AGENT_MAX_TOOL_STEPS: usize = 8;

struct MockInspectTool;
struct MockDiagnoseTool;
struct MockDangerTool;

#[derive(Debug, Clone)]
struct MockPlannedToolAction {
    kind: OpsAgentToolKind,
    command: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct MockPlannedAgentReply {
    reply: String,
    tool: MockPlannedToolAction,
}

struct MockDangerSessionAwareTool {
    observed_sessions: Arc<Mutex<Vec<Option<String>>>>,
}

impl OpsAgentTool for MockInspectTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::new("mock_inspect"),
            description: "Collect runtime metrics.".to_string(),
            usage_notes: vec!["Used in multi-turn tests.".to_string()],
            requires_approval: false,
        }
    }

    fn execute(
        self: Arc<Self>,
        request: OpsAgentToolRequest,
    ) -> TestToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let output = format!("metrics collected for `{}`: cpu=97 mem=88", request.command);
            Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                tool_kind: OpsAgentToolKind::new("mock_inspect"),
                command: request.command,
                output: output.clone(),
                exit_code: Some(0),
                message: output,
                stream_label: Some("mock_inspect".to_string()),
            }))
        })
    }
}

impl OpsAgentTool for MockDiagnoseTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::new("mock_diagnose"),
            description: "Diagnose top process.".to_string(),
            usage_notes: vec!["Used in multi-turn tests.".to_string()],
            requires_approval: false,
        }
    }

    fn execute(
        self: Arc<Self>,
        request: OpsAgentToolRequest,
    ) -> TestToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let output = format!(
                "diagnosis for `{}`: process=java pid=22131 cpu=96",
                request.command
            );
            Ok(OpsAgentToolOutcome::Executed(OpsAgentToolExecution {
                tool_kind: OpsAgentToolKind::new("mock_diagnose"),
                command: request.command,
                output: output.clone(),
                exit_code: Some(0),
                message: output,
                stream_label: Some("mock_diagnose".to_string()),
            }))
        })
    }
}

impl OpsAgentTool for MockDangerTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::new("mock_danger"),
            description: "Dangerous mutating operation that always requires approval.".to_string(),
            usage_notes: vec!["Used in approval tests.".to_string()],
            requires_approval: true,
        }
    }

    fn execute(
        self: Arc<Self>,
        request: OpsAgentToolRequest,
    ) -> TestToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let action = request.state.ops_agent.create_pending_action(
                &request.conversation_id,
                request.current_user_message_id.as_deref(),
                request.session_id.as_deref(),
                OpsAgentToolKind::new("mock_danger"),
                OpsAgentRiskLevel::High,
                &request.command,
                request.reason.as_deref().unwrap_or("mock danger operation"),
            )?;
            Ok(OpsAgentToolOutcome::AwaitingApproval(action))
        })
    }

    fn resolve_action(
        self: Arc<Self>,
        request: OpsAgentToolResolveRequest,
    ) -> TestToolFuture<OpsAgentToolResolution> {
        let _ = self;
        Box::pin(async move {
            let updated = request.state.ops_agent.mark_action_executed(
                &request.action.id,
                "mock danger executed".to_string(),
                0,
                request.approval_comment.clone(),
            )?;
            Ok(OpsAgentToolResolution {
                message: "mock danger resolved".to_string(),
                action: updated,
            })
        })
    }
}

impl OpsAgentTool for MockDangerSessionAwareTool {
    fn definition(&self) -> OpsAgentToolDefinition {
        OpsAgentToolDefinition {
            kind: OpsAgentToolKind::new("mock_danger_session"),
            description: "Dangerous operation that captures session id during resolution."
                .to_string(),
            usage_notes: vec!["Used in session override regression tests.".to_string()],
            requires_approval: true,
        }
    }

    fn execute(
        self: Arc<Self>,
        request: OpsAgentToolRequest,
    ) -> TestToolFuture<OpsAgentToolOutcome> {
        let _ = self;
        Box::pin(async move {
            let action = request.state.ops_agent.create_pending_action(
                &request.conversation_id,
                request.current_user_message_id.as_deref(),
                request.session_id.as_deref(),
                OpsAgentToolKind::new("mock_danger_session"),
                OpsAgentRiskLevel::High,
                &request.command,
                request.reason.as_deref().unwrap_or("mock danger operation"),
            )?;
            Ok(OpsAgentToolOutcome::AwaitingApproval(action))
        })
    }

    fn resolve_action(
        self: Arc<Self>,
        request: OpsAgentToolResolveRequest,
    ) -> TestToolFuture<OpsAgentToolResolution> {
        let observed_sessions = Arc::clone(&self.observed_sessions);
        Box::pin(async move {
            {
                let mut guard = observed_sessions.lock().expect("lock observed sessions");
                guard.push(request.action.session_id.clone());
            }

            let session_label = request
                .action
                .session_id
                .clone()
                .unwrap_or_else(|| "-".to_string());
            let updated = request.state.ops_agent.mark_action_executed(
                &request.action.id,
                format!("mock danger executed in session {session_label}"),
                0,
                request.approval_comment.clone(),
            )?;
            Ok(OpsAgentToolResolution {
                message: format!("mock danger resolved with session {session_label}"),
                action: updated,
            })
        })
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock drift")
        .as_nanos();
    env::temp_dir().join(format!("eshell-ops-agent-service-{name}-{stamp}"))
}

fn test_state_with_registry(registry: OpsAgentToolRegistry) -> Arc<AppState> {
    Arc::new(
        AppState::new_with_ops_agent_tools(temp_dir("agent-tool-flow"), registry)
            .expect("create app state"),
    )
}

fn split_history_for_current_message(
    messages: Vec<OpsAgentMessage>,
    current_message_id: &str,
) -> AppResult<(Vec<OpsAgentMessage>, OpsAgentMessage)> {
    let current_index = messages
        .iter()
        .position(|item| item.id == current_message_id)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "ops agent message {current_message_id} for active chat run"
            ))
        })?;
    let current_message = messages[current_index].clone();
    if current_message.role != OpsAgentRole::User {
        return Err(AppError::Validation(
            "active chat run message must be a user message".to_string(),
        ));
    }

    let history = messages.into_iter().take(current_index).collect::<Vec<_>>();

    Ok((history, current_message))
}

async fn run_mock_agent_tool_flow<F>(
    state: Arc<AppState>,
    conversation_id: &str,
    session_id: Option<&str>,
    question: &str,
    mut planner: F,
) -> AppResult<(String, Option<OpsAgentPendingAction>)>
where
    F: FnMut(&[OpsAgentMessage], &OpsAgentMessage) -> MockPlannedAgentReply,
{
    let user_message = state.ops_agent.append_message(
        conversation_id,
        OpsAgentRole::User,
        question,
        None,
        None,
        Vec::new(),
    )?;
    let conversation = state.ops_agent.get_conversation(conversation_id)?;
    let (mut history, current_user_message) =
        split_history_for_current_message(conversation.messages, &user_message.id)?;

    for _ in 0..MOCK_AGENT_MAX_TOOL_STEPS {
        let plan = planner(&history, &current_user_message);
        if plan.tool.kind.is_none() {
            let final_answer =
                normalized_reply(plan.reply, "No final answer was generated by planner.");
            state.ops_agent.append_message(
                conversation_id,
                OpsAgentRole::Assistant,
                &final_answer,
                None,
                None,
                Vec::new(),
            )?;
            return Ok((final_answer, None));
        }

        let tool = state.ops_agent_tools.get(&plan.tool.kind).ok_or_else(|| {
            crate::error::AppError::Validation(format!("tool {} is not registered", plan.tool.kind))
        })?;

        let command = plan.tool.command.unwrap_or_default();

        match tool
            .execute(crate::ops_agent::tools::OpsAgentToolRequest {
                state: Arc::clone(&state),
                conversation_id: conversation_id.to_string(),
                current_user_message_id: Some(current_user_message.id.clone()),
                session_id: session_id.map(|item| item.to_string()),
                command,
                reason: plan.tool.reason,
            })
            .await?
        {
            OpsAgentToolOutcome::Executed(execution) => {
                let tool_message = state.ops_agent.append_message(
                    conversation_id,
                    OpsAgentRole::Tool,
                    &execution.message,
                    Some(execution.tool_kind),
                    None,
                    Vec::new(),
                )?;
                history.push(tool_message);
            }
            OpsAgentToolOutcome::AwaitingApproval(action) => {
                let prompt = normalized_reply(
                    plan.reply,
                    "I created a command approval request in the chat. Review it before continuing.",
                );
                state.ops_agent.append_message(
                    conversation_id,
                    OpsAgentRole::Assistant,
                    &prompt,
                    None,
                    None,
                    Vec::new(),
                )?;
                return Ok((prompt, Some(action)));
            }
        }
    }

    let limit_message =
        format!("I reached the autonomous tool step limit ({MOCK_AGENT_MAX_TOOL_STEPS}).");
    state.ops_agent.append_message(
        conversation_id,
        OpsAgentRole::Assistant,
        &limit_message,
        None,
        None,
        Vec::new(),
    )?;
    Ok((limit_message, None))
}

#[test]
fn mock_agent_tool_flow_runs_multi_turn_reasoning_with_mock_tools() {
    let mut registry = OpsAgentToolRegistry::new();
    registry.register(MockInspectTool);
    registry.register(MockDiagnoseTool);

    let state = test_state_with_registry(registry);
    let conversation = state
        .ops_agent
        .create_conversation(Some("multi-turn"), None)
        .expect("create conversation");

    let mut planner_calls = 0usize;
    let (answer, pending_action) = tauri::async_runtime::block_on(run_mock_agent_tool_flow(
        Arc::clone(&state),
        &conversation.id,
        None,
        "线上 CPU 抖动，帮我定位根因。",
        |history, _current_user_message| {
            planner_calls += 1;
            let has_metrics = history.iter().any(|item| item.content.contains("cpu=97"));
            let has_java_diagnosis = history
                .iter()
                .any(|item| item.content.contains("process=java"));

            if !has_metrics {
                return MockPlannedAgentReply {
                    reply: "先读取核心指标，确认是否资源瓶颈。".to_string(),
                    tool: MockPlannedToolAction {
                        kind: OpsAgentToolKind::new("mock_inspect"),
                        command: Some("collect_runtime_metrics".to_string()),
                        reason: Some("need baseline metrics".to_string()),
                    },
                };
            }

            if !has_java_diagnosis {
                return MockPlannedAgentReply {
                    reply: "指标异常，再看热点进程定位来源。".to_string(),
                    tool: MockPlannedToolAction {
                        kind: OpsAgentToolKind::new("mock_diagnose"),
                        command: Some("find_hot_process".to_string()),
                        reason: Some("identify culprit process".to_string()),
                    },
                };
            }

            MockPlannedAgentReply {
                reply:
                    "已定位：CPU 抖动主要由 Java 进程引起（pid=22131，cpu≈96%）。建议先抓线程栈再限制并发。"
                        .to_string(),
                tool: MockPlannedToolAction {
                    kind: OpsAgentToolKind::none(),
                    command: None,
                    reason: None,
                },
            }
        },
    ))
    .expect("run mock agent tool flow");

    assert!(pending_action.is_none());
    assert!(answer.contains("Java 进程"));
    assert_eq!(planner_calls, 3);

    let updated = state
        .ops_agent
        .get_conversation(&conversation.id)
        .expect("reload conversation");
    let tool_messages = updated
        .messages
        .iter()
        .filter(|item| item.role == OpsAgentRole::Tool)
        .collect::<Vec<_>>();
    assert_eq!(tool_messages.len(), 2);
    assert!(tool_messages[0].content.contains("metrics"));
    assert!(tool_messages[1].content.contains("process=java"));
}

#[test]
fn mock_agent_tool_flow_can_queue_approval_action() {
    let mut registry = OpsAgentToolRegistry::new();
    registry.register(MockDangerTool);

    let state = test_state_with_registry(registry);
    let conversation = state
        .ops_agent
        .create_conversation(Some("approval"), None)
        .expect("create conversation");

    let (assistant_message, pending_action) =
        tauri::async_runtime::block_on(run_mock_agent_tool_flow(
            Arc::clone(&state),
            &conversation.id,
            None,
            "请直接清理历史日志目录",
            |_history, _current_user_message| MockPlannedAgentReply {
                reply: "该操作有风险，我先发起审批。".to_string(),
                tool: MockPlannedToolAction {
                    kind: OpsAgentToolKind::new("mock_danger"),
                    command: Some("rm -rf /var/log/old".to_string()),
                    reason: Some("cleanup requested by user".to_string()),
                },
            },
        ))
        .expect("run mock agent tool flow");

    let action = pending_action.expect("approval action");
    assert_eq!(action.tool_kind, OpsAgentToolKind::new("mock_danger"));
    assert_eq!(action.status, OpsAgentActionStatus::Pending);
    assert!(action.source_user_message_id.is_some());
    assert!(assistant_message.contains("approval request"));

    let resolved = tauri::async_runtime::block_on(resolve_pending_action(
        Arc::clone(&state),
        None,
        OpsAgentResolveActionInput {
            action_id: action.id.clone(),
            approve: true,
            session_id: None,
            comment: None,
        },
    ))
    .expect("resolve pending action");

    assert_eq!(resolved.action.status, OpsAgentActionStatus::Executed);
    assert_eq!(
        resolved.action.execution_output.as_deref(),
        Some("mock danger executed")
    );
    assert_eq!(
        resolved.action.approval_decision,
        Some(crate::ops_agent::domain::types::OpsAgentApprovalDecision::Approved)
    );
}

#[test]
fn rejecting_pending_action_persists_rejection_decision() {
    let mut registry = OpsAgentToolRegistry::new();
    registry.register(MockDangerTool);

    let state = test_state_with_registry(registry);
    let conversation = state
        .ops_agent
        .create_conversation(Some("approval-reject"), None)
        .expect("create conversation");

    let (_assistant_message, pending_action) =
        tauri::async_runtime::block_on(run_mock_agent_tool_flow(
            Arc::clone(&state),
            &conversation.id,
            None,
            "这是危险操作，请先审批",
            |_history, _current_user_message| MockPlannedAgentReply {
                reply: "该操作有风险，我先发起审批。".to_string(),
                tool: MockPlannedToolAction {
                    kind: OpsAgentToolKind::new("mock_danger"),
                    command: Some("dangerous-operation".to_string()),
                    reason: Some("verify rejection flow".to_string()),
                },
            },
        ))
        .expect("run mock agent tool flow");

    let action = pending_action.expect("approval action");
    let resolved = tauri::async_runtime::block_on(resolve_pending_action(
        Arc::clone(&state),
        None,
        OpsAgentResolveActionInput {
            action_id: action.id.clone(),
            approve: false,
            session_id: None,
            comment: None,
        },
    ))
    .expect("reject pending action");

    assert_eq!(resolved.action.status, OpsAgentActionStatus::Rejected);

    assert_eq!(
        resolved.action.approval_decision,
        Some(crate::ops_agent::domain::types::OpsAgentApprovalDecision::Rejected)
    );
}

#[test]
fn resolving_pending_action_with_comment_keeps_comment_on_action() {
    let mut registry = OpsAgentToolRegistry::new();
    registry.register(MockDangerTool);

    let state = test_state_with_registry(registry);
    let conversation = state
        .ops_agent
        .create_conversation(Some("approval-comment"), None)
        .expect("create conversation");

    let (_assistant_message, pending_action) =
        tauri::async_runtime::block_on(run_mock_agent_tool_flow(
            Arc::clone(&state),
            &conversation.id,
            None,
            "需要高风险操作，请先审批",
            |_history, _current_user_message| MockPlannedAgentReply {
                reply: "这个动作有风险，等待审批。".to_string(),
                tool: MockPlannedToolAction {
                    kind: OpsAgentToolKind::new("mock_danger"),
                    command: Some("dangerous-operation".to_string()),
                    reason: Some("verify comment flow".to_string()),
                },
            },
        ))
        .expect("run mock agent tool flow");

    let action = pending_action.expect("approval action");
    let resolved = tauri::async_runtime::block_on(resolve_pending_action(
        Arc::clone(&state),
        None,
        OpsAgentResolveActionInput {
            action_id: action.id.clone(),
            approve: true,
            session_id: None,
            comment: Some("执行后继续检查服务状态".to_string()),
        },
    ))
    .expect("resolve pending action");

    assert_eq!(resolved.action.status, OpsAgentActionStatus::Executed);
    assert_eq!(
        resolved.action.approval_comment.as_deref(),
        Some("执行后继续检查服务状态")
    );

    let updated = state
        .ops_agent
        .get_conversation(&conversation.id)
        .expect("reload conversation");
    let user_messages = updated
        .messages
        .iter()
        .filter(|item| item.role == OpsAgentRole::User)
        .collect::<Vec<_>>();
    assert_eq!(user_messages.len(), 1);
    assert_eq!(user_messages[0].content, "需要高风险操作，请先审批");
}

#[test]
fn resolve_pending_action_uses_requested_session_override_for_tool_resolution() {
    let observed_sessions = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let mut registry = OpsAgentToolRegistry::new();
    registry.register(MockDangerSessionAwareTool {
        observed_sessions: Arc::clone(&observed_sessions),
    });

    let state = test_state_with_registry(registry);
    let conversation = state
        .ops_agent
        .create_conversation(Some("session-override"), Some("session-1"))
        .expect("create conversation");

    let (_assistant_message, pending_action) =
        tauri::async_runtime::block_on(run_mock_agent_tool_flow(
            Arc::clone(&state),
            &conversation.id,
            Some("session-1"),
            "执行一个需要审批的动作",
            |_history, _current_user_message| MockPlannedAgentReply {
                reply: "该操作有风险，我先发起审批。".to_string(),
                tool: MockPlannedToolAction {
                    kind: OpsAgentToolKind::new("mock_danger_session"),
                    command: Some("dangerous-operation".to_string()),
                    reason: Some("verify session override".to_string()),
                },
            },
        ))
        .expect("run mock agent tool flow");

    let action = pending_action.expect("approval action");
    assert_eq!(action.status, OpsAgentActionStatus::Pending);

    let resolved = tauri::async_runtime::block_on(resolve_pending_action(
        Arc::clone(&state),
        None,
        OpsAgentResolveActionInput {
            action_id: action.id.clone(),
            approve: true,
            session_id: Some("session-2".to_string()),
            comment: None,
        },
    ))
    .expect("resolve pending action");

    assert_eq!(resolved.action.status, OpsAgentActionStatus::Executed);

    let captured_sessions = observed_sessions
        .lock()
        .expect("read captured sessions")
        .clone();
    assert_eq!(captured_sessions, vec![Some("session-2".to_string())]);

    let updated = state
        .ops_agent
        .get_conversation(&conversation.id)
        .expect("reload conversation");
    let last_tool_message = updated
        .messages
        .iter()
        .rev()
        .find(|item| item.role == OpsAgentRole::Tool)
        .expect("tool message appended after resolve");
    assert!(last_tool_message.content.contains("session-2"));
    assert_eq!(
        resolved.action.approval_decision,
        Some(crate::ops_agent::domain::types::OpsAgentApprovalDecision::Approved)
    );
}
