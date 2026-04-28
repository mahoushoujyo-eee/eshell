use std::sync::Arc;

use crate::models::AiConfig;
use crate::ops_agent::domain::types::{
    OpsAgentExecutionReport, OpsAgentKind, OpsAgentReviewReport, OpsAgentRunPhase,
    OpsAgentWorkflowPlan,
};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;
use crate::state::AppState;

use super::{AgentFuture, OpsSubAgent};

pub struct ReviewerAgent;

pub struct ReviewerAgentInput {
    pub state: Arc<AppState>,
    pub run_id: String,
    pub conversation_id: String,
    pub config: AiConfig,
    pub plan: OpsAgentWorkflowPlan,
    pub execution: OpsAgentExecutionReport,
}

impl OpsSubAgent for ReviewerAgent {
    type Input = ReviewerAgentInput;
    type Output = OpsAgentReviewReport;

    fn kind(&self) -> OpsAgentKind {
        OpsAgentKind::Reviewer
    }

    fn phase(&self) -> OpsAgentRunPhase {
        OpsAgentRunPhase::Reviewing
    }

    fn run(&self, input: Self::Input) -> AgentFuture<Self::Output> {
        Box::pin(async move {
            crate::ops_agent::core::llm::review_execution(
                &input.config,
                &input.plan,
                &input.execution,
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
