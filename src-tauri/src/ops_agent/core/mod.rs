pub mod agents;
pub mod compaction;
pub(crate) mod helpers;
pub mod llm;
pub mod orchestrator;
pub mod prompting;
pub mod runtime;

pub(crate) const OPS_AGENT_RUN_CANCELLED: &str = "__ops_agent_run_cancelled__";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessChatOutcome {
    Completed,
}
