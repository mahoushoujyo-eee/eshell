use std::future::Future;
use std::pin::Pin;

use crate::error::AppResult;
use crate::ops_agent::domain::types::{OpsAgentKind, OpsAgentRunPhase};

mod executor;
mod planner;
mod reviewer;
mod validator;

pub use executor::{ExecutorAgent, ExecutorAgentInput, ExecutorAgentOutput};
pub use planner::{PlannerAgent, PlannerAgentInput};
pub use reviewer::{ReviewerAgent, ReviewerAgentInput};
pub use validator::{ValidatorAgent, ValidatorAgentInput};

pub type AgentFuture<T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'static>>;

pub trait OpsSubAgent: Send + Sync {
    type Input: Send + 'static;
    type Output: Send + 'static;

    fn kind(&self) -> OpsAgentKind;
    fn phase(&self) -> OpsAgentRunPhase;
    fn run(&self, input: Self::Input) -> AgentFuture<Self::Output>;
}
