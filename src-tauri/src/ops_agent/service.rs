mod chat;
mod helpers;
mod react_loop;
mod resolve;
mod runtime;

pub use chat::{
    cancel_chat_run, create_conversation, delete_conversation, get_conversation,
    list_conversations, list_pending_actions, set_active_conversation, start_chat_stream,
};
pub use resolve::resolve_pending_action;

pub(super) const OPS_AGENT_RUN_CANCELLED: &str = "__ops_agent_run_cancelled__";
pub(super) const OPS_AGENT_MAX_REACT_STEPS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProcessChatOutcome {
    Completed,
    Cancelled,
}

#[cfg(test)]
mod tests;
