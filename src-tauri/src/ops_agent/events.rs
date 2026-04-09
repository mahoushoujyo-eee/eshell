use tauri::{AppHandle, Emitter};

use super::types::{
    OpsAgentPendingAction, OpsAgentStreamEvent, OpsAgentStreamStage, OpsAgentToolCall,
};

/// Thin helper around Tauri event emission so service code stays protocol-focused.
pub struct OpsAgentEventEmitter {
    app: AppHandle,
    run_id: String,
    conversation_id: String,
}

impl OpsAgentEventEmitter {
    pub fn new(
        app: AppHandle,
        run_id: impl Into<String>,
        conversation_id: impl Into<String>,
    ) -> Self {
        Self {
            app,
            run_id: run_id.into(),
            conversation_id: conversation_id.into(),
        }
    }

    pub fn started(&self) {
        self.emit(OpsAgentStreamStage::Started, |event| event);
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
        let _ = self.app.emit("ops-agent-stream", event);
    }
}
