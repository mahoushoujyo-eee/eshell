//! Project registry: local working directories ACP sessions run in.
//!
//! Stored as `.eshell-data/projects.json`. Each project maps one display name
//! to one local path; session history records reference it by id so the panel
//! can group past conversations per project. Projects are deliberately thin —
//! a path plus a name — because the cwd is the only thing the agent protocol
//! actually needs (`session/new` takes it per session).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const PROJECTS_FILE: &str = "projects.json";

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

fn projects_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(PROJECTS_FILE)
}

/// Reads the registry; a missing or unreadable file yields an empty list so a
/// hand-edited file can never block the panel.
fn load(data_dir: &Path) -> Vec<AcpProject> {
    let path = projects_path(data_dir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<ProjectsFile>(&raw)
        .unwrap_or_default()
        .projects
}

fn save(data_dir: &Path, projects: &[AcpProject]) -> AppResult<()> {
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
fn normalize_for_compare(path: &str) -> String {
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
        created_at: crate::models::now_rfc3339(),
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
fn project_name(path: &Path, raw: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "eshell-projects-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn round_trips_projects_through_disk() {
        let dir = temp_dir();
        let project = AcpProject {
            id: "p1".to_string(),
            name: "eshell".to_string(),
            path: "D:/goc/eshell".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        save(&dir, &[project.clone()]).expect("save");
        let loaded = load(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "eshell");
        assert_eq!(loaded[0].path, "D:/goc/eshell");
    }

    #[test]
    fn missing_file_reads_as_empty_and_corrupt_file_does_not_panic() {
        let dir = temp_dir();
        assert!(load(&dir).is_empty());
        std::fs::write(projects_path(&dir), "{ not json").expect("write junk");
        assert!(load(&dir).is_empty());
    }

    #[test]
    fn path_comparison_ignores_separator_style_and_trailing_slashes() {
        assert_eq!(
            normalize_for_compare("D:\\goc\\eshell\\"),
            normalize_for_compare("D:/goc/eshell")
        );
    }

    #[test]
    fn project_name_falls_back_to_path_for_roots() {
        assert_eq!(project_name(Path::new("D:/goc/eshell"), "D:/goc/eshell"), "eshell");
        // `Path::file_name` is None for a bare root, so the raw string stands in.
        assert_eq!(project_name(Path::new("/"), "/"), "/");
    }
}
