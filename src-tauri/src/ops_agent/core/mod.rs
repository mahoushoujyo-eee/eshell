pub mod compaction;
pub(crate) mod helpers;
pub mod llm;
pub mod prompting;
pub mod react_loop;
pub mod runtime;

pub(crate) const OPS_AGENT_RUN_CANCELLED: &str = "__ops_agent_run_cancelled__";
pub(crate) const OPS_AGENT_MAX_REACT_STEPS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessChatOutcome {
    Completed,
    Cancelled,
}
