use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};

#[derive(Default)]
struct OpsAgentRunRegistryInner {
    runs: HashMap<String, OpsAgentRunEntry>,
    conversation_to_run: HashMap<String, String>,
}

struct OpsAgentRunEntry {
    conversation_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct OpsAgentRunRegistry {
    inner: Arc<Mutex<OpsAgentRunRegistryInner>>,
}

#[derive(Clone)]
pub struct OpsAgentRunHandle {
    cancelled: Arc<AtomicBool>,
}

impl OpsAgentRunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        run_id: impl Into<String>,
        conversation_id: impl Into<String>,
    ) -> AppResult<OpsAgentRunHandle> {
        let run_id = run_id.into();
        let conversation_id = conversation_id.into();

        let mut guard = self.inner.lock().expect("ops agent run lock poisoned");
        if let Some(existing_run_id) = guard.conversation_to_run.get(&conversation_id) {
            return Err(AppError::Validation(format!(
                "conversation {conversation_id} already has an active run ({existing_run_id})"
            )));
        }
        if guard.runs.contains_key(&run_id) {
            return Err(AppError::Validation(format!(
                "ops agent run {run_id} is already registered"
            )));
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        guard.runs.insert(
            run_id.clone(),
            OpsAgentRunEntry {
                conversation_id: conversation_id.clone(),
                cancelled: Arc::clone(&cancelled),
            },
        );
        guard.conversation_to_run.insert(conversation_id, run_id);

        Ok(OpsAgentRunHandle { cancelled })
    }

    pub fn cancel(&self, run_id: &str) -> AppResult<bool> {
        let guard = self.inner.lock().expect("ops agent run lock poisoned");
        let entry = guard
            .runs
            .get(run_id)
            .ok_or_else(|| AppError::NotFound(format!("ops agent run {run_id}")))?;

        let already_cancelled = entry.cancelled.swap(true, Ordering::SeqCst);
        Ok(!already_cancelled)
    }

    pub fn finish(&self, run_id: &str) {
        let mut guard = self.inner.lock().expect("ops agent run lock poisoned");
        if let Some(entry) = guard.runs.remove(run_id) {
            guard.conversation_to_run.remove(&entry.conversation_id);
        }
    }
}

impl OpsAgentRunHandle {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prevents_conversation_parallel_runs_and_releases_after_finish() {
        let registry = OpsAgentRunRegistry::new();
        registry
            .register("run-1", "conv-1")
            .expect("register first run");

        let duplicate = registry.register("run-2", "conv-1");
        assert!(duplicate.is_err());

        registry.finish("run-1");
        registry
            .register("run-2", "conv-1")
            .expect("register after finish");
    }

    #[test]
    fn cancel_marks_handle_state() {
        let registry = OpsAgentRunRegistry::new();
        let handle = registry.register("run-1", "conv-1").expect("register run");
        assert!(!handle.is_cancelled());

        let first_cancel = registry.cancel("run-1").expect("cancel run");
        assert!(first_cancel);
        assert!(handle.is_cancelled());

        let second_cancel = registry.cancel("run-1").expect("cancel again");
        assert!(!second_cancel);
    }
}
