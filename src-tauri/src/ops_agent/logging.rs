use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::now_rfc3339;
use crate::state::AppState;

static OPS_AGENT_LOG_LOCK: Mutex<()> = Mutex::new(());
const OPS_AGENT_LOG_FILE: &str = "ops_agent_debug.log";

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

fn sanitize_for_single_line(text: &str) -> String {
    text.replace('\n', "\\n").replace('\r', "\\r")
}
