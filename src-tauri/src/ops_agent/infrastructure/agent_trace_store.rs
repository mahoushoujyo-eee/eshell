use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::models::now_rfc3339;
use crate::ops_agent::domain::types::{OpsAgentKind, OpsAgentRunPhase};

const RUNS_DIR: &str = "ops_agent_runs";

static AGENT_TRACE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentRunManifest {
    pub run_id: String,
    pub conversation_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub source_user_message_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsAgentTraceEvent {
    pub run_id: String,
    pub conversation_id: String,
    pub phase: Option<OpsAgentRunPhase>,
    pub agent_kind: Option<OpsAgentKind>,
    pub event: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Clone)]
pub struct OpsAgentTraceStore {
    runs_dir: PathBuf,
}

impl OpsAgentTraceStore {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        let runs_dir = root.join(RUNS_DIR);
        fs::create_dir_all(&runs_dir)?;
        Ok(Self { runs_dir })
    }

    pub fn create_run(&self, manifest: &OpsAgentRunManifest) -> AppResult<()> {
        let _guard = AGENT_TRACE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let run_dir = self.run_dir(&manifest.run_id);
        fs::create_dir_all(run_dir.join("agents"))?;
        fs::create_dir_all(run_dir.join("artifacts"))?;
        write_json_pretty(&run_dir.join("manifest.json"), manifest)?;
        Ok(())
    }

    pub fn append_event(&self, event: OpsAgentTraceEvent) -> AppResult<()> {
        let _guard = AGENT_TRACE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let run_dir = self.run_dir(&event.run_id);
        fs::create_dir_all(&run_dir)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(run_dir.join("timeline.jsonl"))?;
        let line = serde_json::to_string(&event)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        Ok(())
    }

    pub fn write_agent_io<T, U>(
        &self,
        run_id: &str,
        sequence: usize,
        agent_kind: OpsAgentKind,
        request: &T,
        response: &U,
    ) -> AppResult<()>
    where
        T: serde::Serialize,
        U: serde::Serialize,
    {
        let _guard = AGENT_TRACE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let agents_dir = self.run_dir(run_id).join("agents");
        fs::create_dir_all(&agents_dir)?;
        let prefix = format!("{sequence:03}-{}", agent_kind.as_str());
        write_json_pretty(&agents_dir.join(format!("{prefix}.request.json")), request)?;
        write_json_pretty(
            &agents_dir.join(format!("{prefix}.response.json")),
            response,
        )?;
        Ok(())
    }

    pub fn trace_event(
        &self,
        run_id: &str,
        conversation_id: &str,
        phase: Option<OpsAgentRunPhase>,
        agent_kind: Option<OpsAgentKind>,
        event: impl Into<String>,
        message: impl Into<String>,
    ) -> AppResult<()> {
        self.append_event(OpsAgentTraceEvent {
            run_id: run_id.to_string(),
            conversation_id: conversation_id.to_string(),
            phase,
            agent_kind,
            event: event.into(),
            message: message.into(),
            created_at: now_rfc3339(),
        })
    }

    fn run_dir(&self, run_id: &str) -> PathBuf {
        self.runs_dir.join(sanitize_path_segment(run_id))
    }
}

fn sanitize_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn write_json_pretty<T>(path: &Path, value: &T) -> AppResult<()>
where
    T: serde::Serialize,
{
    let text = serde_json::to_string_pretty(value)?;
    fs::write(path, text)?;
    Ok(())
}
