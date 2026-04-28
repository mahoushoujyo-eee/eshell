use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

use crate::ops_agent::domain::types::{
    OpsAgentKind, OpsAgentPendingAction, OpsAgentProgress, OpsAgentProgressStatus,
    OpsAgentRunPhase, OpsAgentStreamEvent, OpsAgentStreamStage, OpsAgentToolCall,
};
use crate::ops_agent::infrastructure::logging::{append_debug_log_at_path, truncate_for_log};

/// Thin helper around Tauri event emission so service code stays protocol-focused.
#[derive(Clone)]
pub struct OpsAgentEventEmitter {
    app: AppHandle,
    log_path: PathBuf,
    run_id: String,
    conversation_id: String,
}

impl OpsAgentEventEmitter {
    pub fn new(
        app: AppHandle,
        log_path: PathBuf,
        run_id: impl Into<String>,
        conversation_id: impl Into<String>,
    ) -> Self {
        Self {
            app,
            log_path,
            run_id: run_id.into(),
            conversation_id: conversation_id.into(),
        }
    }

    pub fn started(&self) {
        self.emit(OpsAgentStreamStage::Started, |event| event);
    }

    pub fn phase_changed(
        &self,
        phase: OpsAgentRunPhase,
        agent_kind: OpsAgentKind,
        summary: impl Into<String>,
    ) {
        self.emit(OpsAgentStreamStage::PhaseChanged, |event| {
            let mut next = event;
            next.phase = Some(phase);
            next.agent_kind = Some(agent_kind);
            next.summary = Some(summary.into());
            next
        });
    }

    pub fn agent_started(
        &self,
        phase: OpsAgentRunPhase,
        agent_kind: OpsAgentKind,
        title: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.emit(OpsAgentStreamStage::AgentStarted, |event| {
            let title = title.into();
            let message = normalize_optional_text(message.into());
            let mut next = event;
            next.phase = Some(phase);
            next.agent_kind = Some(agent_kind);
            next.summary = Some(title.clone());
            next.progress = Some(OpsAgentProgress {
                status: OpsAgentProgressStatus::Started,
                title,
                message,
                step_index: None,
                step_total: None,
            });
            next
        });
    }

    pub fn agent_progress(
        &self,
        phase: OpsAgentRunPhase,
        agent_kind: OpsAgentKind,
        title: impl Into<String>,
        message: impl Into<String>,
        step_index: Option<usize>,
        step_total: Option<usize>,
    ) {
        self.emit(OpsAgentStreamStage::AgentProgress, |event| {
            let title = title.into();
            let message = normalize_optional_text(message.into());
            let mut next = event;
            next.phase = Some(phase);
            next.agent_kind = Some(agent_kind);
            next.summary = Some(title.clone());
            next.progress = Some(OpsAgentProgress {
                status: OpsAgentProgressStatus::Running,
                title,
                message,
                step_index,
                step_total,
            });
            next
        });
    }

    pub fn agent_completed(
        &self,
        phase: OpsAgentRunPhase,
        agent_kind: OpsAgentKind,
        title: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.emit(OpsAgentStreamStage::AgentCompleted, |event| {
            let title = title.into();
            let message = normalize_optional_text(message.into());
            let mut next = event;
            next.phase = Some(phase);
            next.agent_kind = Some(agent_kind);
            next.summary = Some(title.clone());
            next.progress = Some(OpsAgentProgress {
                status: OpsAgentProgressStatus::Completed,
                title,
                message,
                step_index: None,
                step_total: None,
            });
            next
        });
    }

    pub fn delta(&self, chunk: impl Into<String>) {
        self.emit(OpsAgentStreamStage::Delta, |event| {
            let mut next = event;
            next.chunk = Some(chunk.into());
            next
        });
    }

    pub fn tool_call(&self, tool_call: OpsAgentToolCall) {
        self.emit(OpsAgentStreamStage::ToolCall, |event| {
            let mut next = event;
            next.tool_call = Some(tool_call);
            next
        });
    }

    pub fn tool_read(&self, chunk: impl Into<String>, tool_call: Option<OpsAgentToolCall>) {
        self.emit(OpsAgentStreamStage::ToolRead, |event| {
            let mut next = event;
            next.chunk = Some(chunk.into());
            next.tool_call = tool_call;
            next
        });
    }

    pub fn requires_approval(
        &self,
        pending_action: OpsAgentPendingAction,
        tool_call: Option<OpsAgentToolCall>,
    ) {
        self.emit(OpsAgentStreamStage::RequiresApproval, |event| {
            let mut next = event;
            next.tool_call = tool_call;
            next.pending_action = Some(pending_action);
            next
        });
    }

    pub fn completed(&self, full_answer: String, pending_action: Option<OpsAgentPendingAction>) {
        self.emit(OpsAgentStreamStage::Completed, |event| {
            let mut next = event;
            next.full_answer = Some(full_answer);
            next.pending_action = pending_action;
            next
        });
    }

    pub fn error(&self, message: impl Into<String>) {
        self.emit(OpsAgentStreamStage::Error, |event| {
            let mut next = event;
            next.error = Some(message.into());
            next
        });
    }

    fn emit<F>(&self, stage: OpsAgentStreamStage, mutate: F)
    where
        F: FnOnce(OpsAgentStreamEvent) -> OpsAgentStreamEvent,
    {
        let event = mutate(OpsAgentStreamEvent::new(
            self.run_id.clone(),
            self.conversation_id.clone(),
            stage,
        ));
        self.log_event(&event);
        let _ = self.app.emit("ops-agent-stream", event);
    }

    fn log_event(&self, event: &OpsAgentStreamEvent) {
        append_debug_log_at_path(
            &self.log_path,
            "transport.event.emit",
            Some(self.run_id.as_str()),
            Some(self.conversation_id.as_str()),
            format!(
                "stage={:?} phase={} agent={} progress={} chunk_chars={} full_answer_chars={} tool_call={} pending_action={} error_preview={}",
                event.stage,
                event.phase.as_ref().map(|item| item.as_str()).unwrap_or("-"),
                event.agent_kind.as_ref().map(|item| item.as_str()).unwrap_or("-"),
                describe_progress(event.progress.as_ref()),
                event.chunk.as_ref().map(|item| item.chars().count()).unwrap_or(0),
                event
                    .full_answer
                    .as_ref()
                    .map(|item| item.chars().count())
                    .unwrap_or(0),
                describe_tool_call(event.tool_call.as_ref()),
                describe_pending_action(event.pending_action.as_ref()),
                truncate_for_log(event.error.as_deref().unwrap_or(""), 160),
            ),
        );
    }
}

fn normalize_optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn describe_tool_call(tool_call: Option<&OpsAgentToolCall>) -> String {
    let Some(tool_call) = tool_call else {
        return "-".to_string();
    };

    format!(
        "{}:{}:{:?}",
        tool_call.id, tool_call.tool_kind, tool_call.status
    )
}

fn describe_pending_action(action: Option<&OpsAgentPendingAction>) -> String {
    let Some(action) = action else {
        return "-".to_string();
    };

    format!("{}:{}:{:?}", action.id, action.tool_kind, action.status)
}

fn describe_progress(progress: Option<&OpsAgentProgress>) -> String {
    let Some(progress) = progress else {
        return "-".to_string();
    };

    format!(
        "{:?}:{}:{}",
        progress.status,
        truncate_for_log(progress.title.as_str(), 80),
        progress
            .message
            .as_deref()
            .map(|value| truncate_for_log(value, 80))
            .unwrap_or_else(|| "-".to_string())
    )
}
