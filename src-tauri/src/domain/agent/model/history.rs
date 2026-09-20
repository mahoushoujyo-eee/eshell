//! Persisted session transcripts.
//!
//! Transcripts live under `.eshell-data/acp_sessions/` so the panel can list
//! and reopen past conversations even when the agent itself cannot
//! (`session/load` resume is attempted when the agent supports it).

use serde::{Deserialize, Serialize};

use crate::domain::agent::consts::ACP_SESSIONS_DIR;

/// Lists configured agents with running state.

// ---------- Local session history ----------
//
// Transcripts are persisted app-side under `.eshell-data/acp_sessions/` so the
// panel can list and reopen past conversations even when the agent itself
// cannot (`session/load` resume is attempted when the agent supports it).

/// One persisted session transcript. `transcript` is the panel's own entry
/// array, stored verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryRecord {
    pub id: String,
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// Project this session ran in; `None` for sessions started without one
    /// (and for records written before projects existed).
    #[serde(default)]
    pub project_id: Option<String>,
    /// Session working directory, so a resume reopens in the same folder.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub transcript: serde_json::Value,
}

/// List row: everything except the transcript body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryMeta {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub entry_count: usize,
    pub project_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistorySaveInput {
    pub record: AcpHistoryRecord,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryIdInput {
    pub id: String,
}

pub(crate) fn history_dir(state: &crate::state::AppState) -> std::path::PathBuf {
    state.storage.data_dir().join(ACP_SESSIONS_DIR)
}

/// Session ids come from the agent; keep only filesystem-safe characters.
pub(crate) fn history_file_name(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    format!("{sanitized}.json")
}
