//! Project registry service: local working directories ACP sessions run in,
//! persisted as `.eshell-data/projects.json`.

//! Project registry: local working directories ACP sessions run in.
//!
//! Stored as `.eshell-data/projects.json`. Each project maps one display name
//! to one local path; session history records reference it by id so the panel
//! can group past conversations per project. Projects are deliberately thin —
//! a path plus a name — because the cwd is the only thing the agent protocol
//! actually needs (`session/new` takes it per session).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::common::error::{AppError, AppResult};

use crate::domain::agent::consts::PROJECTS_FILE;

/// One local project root an ACP session can run in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProjectsFile {
    #[serde(default)]
    projects: Vec<AcpProject>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProjectCreateInput {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProjectIdInput {
    pub id: String,
}

pub(crate) fn projects_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(PROJECTS_FILE)
}

/// Reads the registry; a missing or unreadable file yields an empty list so a
/// hand-edited file can never block the panel.
pub(crate) fn load(data_dir: &Path) -> Vec<AcpProject> {
    let path = projects_path(data_dir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<ProjectsFile>(&raw)
        .unwrap_or_default()
        .projects
}

pub(crate) fn save(data_dir: &Path, projects: &[AcpProject]) -> AppResult<()> {
    let path = projects_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(&ProjectsFile {
        projects: projects.to_vec(),
    })?;
    std::fs::write(path, serialized).map_err(AppError::Io)
}

/// Trims trailing separators and unifies them to `/` for comparison only —
/// the stored path keeps whatever the OS folder picker returned.
pub(crate) fn normalize_for_compare(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    trimmed.replace('\\', "/")
}

/// Lists registered projects, oldest first (stable panel ordering).
#[tauri::command]
pub async fn acp_project_list(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<Vec<AcpProject>, String> {
    Ok(load(&state.storage.data_dir()))
}

/// Registers a local directory as a project. Picking the same directory twice
/// returns the existing entry instead of creating a duplicate.
#[tauri::command]
pub async fn acp_project_create(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    input: AcpProjectCreateInput,
) -> Result<AcpProject, String> {
    let raw = input.path.trim();
    if raw.is_empty() {
        return Err("project path is empty".to_string());
    }
    let path = std::path::PathBuf::from(raw);
    if !path.is_dir() {
        return Err(format!("not a directory: {raw}"));
    }

    let data_dir = state.storage.data_dir();
    let mut projects = load(&data_dir);
    let wanted = normalize_for_compare(raw);
    if let Some(existing) = projects
        .iter()
        .find(|project| normalize_for_compare(&project.path) == wanted)
    {
        return Ok(existing.clone());
    }

    let project = AcpProject {
        id: uuid::Uuid::new_v4().to_string(),
        name: project_name(&path, raw),
        path: raw.to_string(),
        created_at: crate::common::time::now_rfc3339(),
    };
    projects.push(project.clone());
    save(&data_dir, &projects).map_err(|e| e.to_string())?;
    Ok(project)
}

/// Removes a project from the registry. Session transcripts that reference it
/// are kept — they simply fall back to the ungrouped section in the panel,
/// because losing conversations to a folder-organization change would be rude.
#[tauri::command]
pub async fn acp_project_delete(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    input: AcpProjectIdInput,
) -> Result<(), String> {
    let data_dir = state.storage.data_dir();
    let mut projects = load(&data_dir);
    let before = projects.len();
    projects.retain(|project| project.id != input.id);
    if projects.len() == before {
        return Ok(());
    }
    save(&data_dir, &projects).map_err(|e| e.to_string())
}

/// Display name: the directory's own name, falling back to the full path for
/// roots (`C:\`, `/`) that have none.
pub(crate) fn project_name(path: &Path, raw: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| raw.to_string())
}
