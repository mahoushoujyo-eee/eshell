mod shell;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::context::OpsAgentToolPromptHint;
use super::types::{OpsAgentPendingAction, OpsAgentToolKind};

pub use shell::{ShellTool, UiContextTool};

type ToolFuture<T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'static>>;

/// Static metadata describing one registered tool.
#[derive(Debug, Clone)]
pub struct OpsAgentToolDefinition {
    pub kind: OpsAgentToolKind,
    pub description: String,
    pub usage_notes: Vec<String>,
    pub requires_approval: bool,
}

impl OpsAgentToolDefinition {
    pub fn to_prompt_hint(&self) -> OpsAgentToolPromptHint {
        OpsAgentToolPromptHint {
            kind: self.kind.clone(),
            description: self.description.clone(),
            usage_notes: self.usage_notes.clone(),
            requires_approval: self.requires_approval,
        }
    }
}

/// Input provided to a tool when the planner requests execution.
pub struct OpsAgentToolRequest {
    pub state: Arc<AppState>,
    pub conversation_id: String,
    pub current_user_message_id: Option<String>,
    pub session_id: Option<String>,
    pub command: String,
    pub reason: Option<String>,
}

/// Output returned by an immediately executed tool.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct OpsAgentToolExecution {
    pub tool_kind: OpsAgentToolKind,
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub message: String,
    pub stream_label: Option<String>,
}

/// Output returned when a previously queued action is resolved.
#[derive(Debug, Clone)]
pub struct OpsAgentToolResolution {
    pub action: OpsAgentPendingAction,
    pub message: String,
}

/// Tool invocation result. Some tools execute immediately, others enqueue approval steps.
#[derive(Debug, Clone)]
pub enum OpsAgentToolOutcome {
    Executed(OpsAgentToolExecution),
    AwaitingApproval(OpsAgentPendingAction),
}

/// Input provided to a tool when a pending action is approved or rejected.
pub struct OpsAgentToolResolveRequest {
    pub state: Arc<AppState>,
    pub action: OpsAgentPendingAction,
}

/// Tool trait used by the registry. New tools only need to implement this contract.
pub trait OpsAgentTool: Send + Sync {
    fn definition(&self) -> OpsAgentToolDefinition;

    fn execute(self: Arc<Self>, request: OpsAgentToolRequest) -> ToolFuture<OpsAgentToolOutcome>;

    fn resolve_action(
        self: Arc<Self>,
        request: OpsAgentToolResolveRequest,
    ) -> ToolFuture<OpsAgentToolResolution> {
        let kind = self.definition().kind;
        let _ = request;
        Box::pin(async move {
            Err(AppError::Validation(format!(
                "tool {kind} does not support pending action resolution"
            )))
        })
    }
}

/// Runtime registry that keeps tool definitions and handlers in one place.
#[derive(Clone, Default)]
pub struct OpsAgentToolRegistry {
    tools: HashMap<String, Arc<dyn OpsAgentTool>>,
}

impl OpsAgentToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn register<T>(&mut self, tool: T) -> &mut Self
    where
        T: OpsAgentTool + 'static,
    {
        let tool = Arc::new(tool);
        let key = tool.definition().kind.to_string();
        self.tools.insert(key, tool);
        self
    }

    pub fn get(&self, kind: &OpsAgentToolKind) -> Option<Arc<dyn OpsAgentTool>> {
        if let Some(tool) = self.tools.get(kind.as_str()) {
            return Some(tool.clone());
        }

        // Compatibility alias for older persisted tool kinds.
        if kind == &OpsAgentToolKind::read_shell() || kind == &OpsAgentToolKind::write_shell() {
            return self.tools.get(OpsAgentToolKind::shell().as_str()).cloned();
        }

        None
    }

    pub fn prompt_hints(&self) -> Vec<OpsAgentToolPromptHint> {
        let mut rows = self
            .tools
            .values()
            .map(|tool| tool.definition().to_prompt_hint())
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.kind.as_str().cmp(right.kind.as_str()));
        rows
    }
}

pub fn default_ops_agent_tool_registry() -> OpsAgentToolRegistry {
    let mut registry = OpsAgentToolRegistry::new();
    registry.register(ShellTool);
    registry.register(UiContextTool);
    registry
}

pub(crate) fn format_execution_output(stdout: &str, stderr: &str, exit_code: i32) -> String {
    let mut sections = Vec::new();
    if !stdout.trim().is_empty() {
        sections.push(format!("stdout:\n{}", stdout.trim_end()));
    }
    if !stderr.trim().is_empty() {
        sections.push(format!("stderr:\n{}", stderr.trim_end()));
    }
    if sections.is_empty() {
        sections.push("<empty output>".to_string());
    }
    sections.push(format!("exitCode: {exit_code}"));
    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubTool;

    impl OpsAgentTool for StubTool {
        fn definition(&self) -> OpsAgentToolDefinition {
            OpsAgentToolDefinition {
                kind: OpsAgentToolKind::new("stub_tool"),
                description: "Stub tool.".to_string(),
                usage_notes: vec!["Used in tests.".to_string()],
                requires_approval: false,
            }
        }

        fn execute(
            self: Arc<Self>,
            _request: OpsAgentToolRequest,
        ) -> ToolFuture<OpsAgentToolOutcome> {
            let _ = self;
            Box::pin(async { Err(AppError::Runtime("not implemented".to_string())) })
        }
    }

    #[test]
    fn registry_supports_multiple_tools() {
        let mut registry = OpsAgentToolRegistry::new();
        registry.register(StubTool);
        registry.register(ShellTool);

        let hints = registry.prompt_hints();
        assert_eq!(hints.len(), 2);
        assert!(registry.get(&OpsAgentToolKind::new("stub_tool")).is_some());
        assert!(registry.get(&OpsAgentToolKind::shell()).is_some());
        assert!(registry.get(&OpsAgentToolKind::write_shell()).is_some());
    }
}
