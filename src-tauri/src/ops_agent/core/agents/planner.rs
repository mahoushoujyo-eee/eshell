use std::sync::Arc;

use crate::models::AiConfig;
use crate::ops_agent::core::prompting::{OpsAgentSessionContext, OpsAgentToolPromptHint};
use crate::ops_agent::domain::types::{
    OpsAgentKind, OpsAgentMessage, OpsAgentRunPhase, OpsAgentWorkflowPlan,
};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;
use crate::state::AppState;

use super::{AgentFuture, OpsSubAgent};

pub struct PlannerAgent;

pub struct PlannerAgentInput {
    pub state: Arc<AppState>,
    pub run_id: String,
    pub conversation_id: String,
    pub config: AiConfig,
    pub history: Vec<OpsAgentMessage>,
    pub current_message: OpsAgentMessage,
    pub session_context: OpsAgentSessionContext,
    pub tool_hints: Vec<OpsAgentToolPromptHint>,
}

impl OpsSubAgent for PlannerAgent {
    type Input = PlannerAgentInput;
    type Output = OpsAgentWorkflowPlan;

    fn kind(&self) -> OpsAgentKind {
        OpsAgentKind::Planner
    }

    fn phase(&self) -> OpsAgentRunPhase {
        OpsAgentRunPhase::Planning
    }

    fn run(&self, input: Self::Input) -> AgentFuture<Self::Output> {
        Box::pin(async move {
            crate::ops_agent::core::llm::plan_workflow(
                input.state.as_ref(),
                &input.config,
                &input.history,
                &input.current_message,
                &input.session_context,
                &input.tool_hints,
                Some(OpsAgentLogContext::new(
                    input.state.as_ref(),
                    Some(input.run_id.as_str()),
                    Some(input.conversation_id.as_str()),
                )),
            )
            .await
        })
    }
}
