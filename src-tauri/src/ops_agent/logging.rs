use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::now_rfc3339;
use crate::state::AppState;

static OPS_AGENT_LOG_LOCK: Mutex<()> = Mutex::new(());
const OPS_AGENT_LOG_FILE: &str = "ops_agent_debug.log";

#[derive(Clone, Copy)]
pub struct OpsAgentLogContext<'a> {
    state: &'a AppState,
    run_id: Option<&'a str>,
    conversation_id: Option<&'a str>,
}

impl<'a> OpsAgentLogContext<'a> {
    pub fn new(
        state: &'a AppState,
        run_id: Option<&'a str>,
        conversation_id: Option<&'a str>,
    ) -> Self {
        Self {
            state,
            run_id,
            conversation_id,
        }
    }

    pub fn append(self, level: &str, message: impl AsRef<str>) {
        append_debug_log(
            self.state,
            level,
            self.run_id,
            self.conversation_id,
            message,
        );
    }
}

pub fn append_debug_log(
    state: &AppState,
    level: &str,
    run_id: Option<&str>,
    conversation_id: Option<&str>,
    message: impl AsRef<str>,
) {
    let _guard = OPS_AGENT_LOG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let log_path = resolve_log_path(state);
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut file = match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(file) => file,
        Err(_) => return,
    };

    let line = format!(
        "{} [{}] run_id={} conversation_id={} {}\n",
        now_rfc3339(),
        level,
        run_id.unwrap_or("-"),
        conversation_id.unwrap_or("-"),
        sanitize_for_single_line(message.as_ref())
    );
    let _ = file.write_all(line.as_bytes());
}

fn resolve_log_path(state: &AppState) -> PathBuf {
    state.storage.data_dir().join(OPS_AGENT_LOG_FILE)
}

pub fn truncate_for_log(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}

fn sanitize_for_single_line(text: &str) -> String {
    text.replace('\n', "\\n").replace('\r', "\\r")
}
