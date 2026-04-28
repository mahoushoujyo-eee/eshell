use std::sync::Arc;

use crate::models::AiConfig;
use crate::ops_agent::domain::types::{
    OpsAgentExecutionReport, OpsAgentKind, OpsAgentReviewReport, OpsAgentRunPhase,
    OpsAgentValidationReport, OpsAgentWorkflowPlan,
};
use crate::ops_agent::infrastructure::logging::OpsAgentLogContext;
use crate::state::AppState;

use super::{AgentFuture, OpsSubAgent};

pub struct ValidatorAgent;

pub struct ValidatorAgentInput {
    pub state: Arc<AppState>,
    pub run_id: String,
    pub conversation_id: String,
    pub config: AiConfig,
    pub plan: OpsAgentWorkflowPlan,
    pub execution: OpsAgentExecutionReport,
    pub review: OpsAgentReviewReport,
}

impl OpsSubAgent for ValidatorAgent {
    type Input = ValidatorAgentInput;
    type Output = OpsAgentValidationReport;

    fn kind(&self) -> OpsAgentKind {
        OpsAgentKind::Validator
    }

    fn phase(&self) -> OpsAgentRunPhase {
        OpsAgentRunPhase::Validating
    }

    fn run(&self, input: Self::Input) -> AgentFuture<Self::Output> {
        Box::pin(async move {
            crate::ops_agent::core::llm::validate_completion(
                &input.config,
                &input.plan,
                &input.execution,
                &input.review,
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
