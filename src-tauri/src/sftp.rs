use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: u64,
    pub permissions: String,
}

pub struct SftpState;

impl SftpState {
    pub fn new() -> Self {
        Self
    }
}

#[tauri::command]
pub fn list_files(
    _state: tauri::State<'_, SftpState>,
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileInfo>, String> {
    let sessions = ssh_state.sessions.read().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = shell_session.session.lock().map_err(|e| e.to_string())?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let dir_path = Path::new(&path);

    let mut files = Vec::new();
    let entries = sftp.readdir(dir_path).map_err(|e| e.to_string())?;

    for (path, stat) in entries {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        files.push(FileInfo {
            name,
            size: stat.size.unwrap_or(0),
            is_dir: stat.is_dir(),
            modified: stat.mtime.unwrap_or(0),
            permissions: format!("{:o}", stat.perm.unwrap_or(0)),
        });
    }

    // Sort: directories first, then by name
    files.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });

    Ok(files)
}

#[tauri::command]
pub fn download_file(
    _state: tauri::State<'_, SftpState>,
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
    remote_path: String,
) -> Result<Vec<u8>, String> {
    let sessions = ssh_state.sessions.lock().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = shell_session.session.lock().map_err(|e| e.to_string())?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let mut remote_file = sftp
        .open(Path::new(&remote_path))
        .map_err(|e| e.to_string())?;

    let mut contents = Vec::new();
    remote_file
        .read_to_end(&mut contents)
        .map_err(|e| e.to_string())?;

    Ok(contents)
}

#[tauri::command]
pub fn upload_file(
    _state: tauri::State<'_, SftpState>,
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
    remote_path: String,
    content: Vec<u8>,
) -> Result<(), String> {
    let sessions = ssh_state.sessions.lock().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = shell_session.session.lock().map_err(|e| e.to_string())?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let mut remote_file = sftp
        .create(Path::new(&remote_path))
        .map_err(|e| e.to_string())?;

    remote_file.write_all(&content).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn delete_file(
    _state: tauri::State<'_, SftpState>,
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sessions = ssh_state.sessions.lock().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = shell_session.session.lock().map_err(|e| e.to_string())?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;

    if is_dir {
        sftp.rmdir(Path::new(&path)).map_err(|e| e.to_string())?;
    } else {
        sftp.unlink(Path::new(&path)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn create_directory(
    _state: tauri::State<'_, SftpState>,
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sessions = ssh_state.sessions.lock().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = shell_session.session.lock().map_err(|e| e.to_string())?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    sftp.mkdir(Path::new(&path), 0o755)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn rename_file(
    _state: tauri::State<'_, SftpState>,
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let sessions = ssh_state.sessions.lock().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = shell_session.session.lock().map_err(|e| e.to_string())?;

    let sftp = session.sftp().map_err(|e| e.to_string())?;
    sftp.rename(Path::new(&old_path), Path::new(&new_path), None)
        .map_err(|e| e.to_string())?;

    Ok(())
}
