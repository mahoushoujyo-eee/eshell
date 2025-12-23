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
    let sessions = ssh_state.sessions.read().map_err(|e| format!("Failed to read sessions: {}", e))?;
    let shell_session = sessions.get(&session_id).ok_or(format!("Session {} not found", session_id))?;
    
    // 检查会话状态
    if let Ok(status) = shell_session.status.read() {
        if !status.connected || !status.active {
            return Err(format!("Session {} is not connected or inactive", session_id));
        }
    } else {
        return Err(format!("Failed to get status for session {}", session_id));
    }
    
    let session = &shell_session.session;

    let sess = session.lock().map_err(|e| format!("[Session({})] Failed to lock session: {}", session_id, e))?;
    let sftp = sess.sftp().map_err(|e| format!("[Session({})] Unable to startup SFTP channel: {}", session_id, e))?;
    let dir_path = Path::new(&path);

    let mut files = Vec::new();
    let entries = sftp.readdir(dir_path).map_err(|e| format!("[Session({})] Failed to list directory {}: {}", session_id, path, e))?;

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
    let sessions = ssh_state.sessions.read().map_err(|e| format!("Failed to read sessions: {}", e))?;
    let shell_session = sessions.get(&session_id).ok_or(format!("Session {} not found", session_id))?;
    
    if let Ok(status) = shell_session.status.read() {
        if !status.connected || !status.active {
            return Err(format!("Session {} is not connected or inactive", session_id));
        }
    } else {
        return Err(format!("Failed to get status for session {}", session_id));
    }
    
    let session = &shell_session.session;

    let sess = session.lock().map_err(|e| format!("[Session({})] Failed to lock session: {}", session_id, e))?;
    let sftp = sess.sftp().map_err(|e| format!("[Session({})] Unable to startup SFTP channel: {}", session_id, e))?;
    
    let path = Path::new(&remote_path);
    
    let stat = sftp.stat(path).map_err(|e| {
        format!("[Session({})] Failed to stat file {}: {} (SFTP error code: {:?})", session_id, remote_path, e, e)
    })?;
    
    eprintln!("[Session({})] File stats for {}: size={}, is_dir={}, perms={:o}", 
        session_id, remote_path, stat.size.unwrap_or(0), stat.is_dir(), stat.perm.unwrap_or(0));
    
    if stat.is_dir() {
        return Err(format!("[Session({})] Cannot download directory: {}", session_id, remote_path));
    }
    
    let perms = stat.perm.unwrap_or(0);
    if perms & 0o400 == 0 {
        return Err(format!("[Session({})] No read permission for file: {} (permissions: {:o})", 
            session_id, remote_path, perms));
    }
    
    let mut remote_file = sftp
        .open(path)
        .map_err(|e| {
            format!("[Session({})] Failed to open file {}: {} (SFTP error code: {:?}). Possible causes: insufficient permissions, file not found, disk full, or file locked.", 
                session_id, remote_path, e, e)
        })?;

    let mut contents = Vec::new();
    remote_file
        .read_to_end(&mut contents)
        .map_err(|e| format!("[Session({})] Failed to read file {}: {}", session_id, remote_path, e))?;

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
    let sessions = ssh_state.sessions.read().map_err(|e| format!("Failed to read sessions: {}", e))?;
    let shell_session = sessions.get(&session_id).ok_or(format!("Session {} not found", session_id))?;
    
    // 检查会话状态
    if let Ok(status) = shell_session.status.read() {
        if !status.connected || !status.active {
            return Err(format!("Session {} is not connected or inactive", session_id));
        }
    } else {
        return Err(format!("Failed to get status for session {}", session_id));
    }
    
    let session = &shell_session.session;

    let sess = session.lock().map_err(|e| format!("[Session({})] Failed to lock session: {}", session_id, e))?;
    let sftp = sess.sftp().map_err(|e| format!("[Session({})] Unable to startup SFTP channel: {}", session_id, e))?;
    let mut remote_file = sftp
        .create(Path::new(&remote_path))
        .map_err(|e| format!("[Session({})] Failed to create file {}: {}", session_id, remote_path, e))?;

    remote_file.write_all(&content).map_err(|e| format!("[Session({})] Failed to write to file {}: {}", session_id, remote_path, e))?;

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
    let sessions = ssh_state.sessions.read().map_err(|e| format!("Failed to read sessions: {}", e))?;
    let shell_session = sessions.get(&session_id).ok_or(format!("Session {} not found", session_id))?;
    
    // 检查会话状态
    if let Ok(status) = shell_session.status.read() {
        if !status.connected || !status.active {
            return Err(format!("Session {} is not connected or inactive", session_id));
        }
    } else {
        return Err(format!("Failed to get status for session {}", session_id));
    }
    
    let session = &shell_session.session;

    let sess = session.lock().map_err(|e| format!("[Session({})] Failed to lock session: {}", session_id, e))?;
    let sftp = sess.sftp().map_err(|e| format!("[Session({})] Unable to startup SFTP channel: {}", session_id, e))?;

    if is_dir {
        sftp.rmdir(Path::new(&path)).map_err(|e| format!("[Session({})] Failed to remove directory {}: {}", session_id, path, e))?;
    } else {
        sftp.unlink(Path::new(&path)).map_err(|e| format!("[Session({})] Failed to remove file {}: {}", session_id, path, e))?;
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
    let sessions = ssh_state.sessions.read().map_err(|e| format!("Failed to read sessions: {}", e))?;
    let shell_session = sessions.get(&session_id).ok_or(format!("Session {} not found", session_id))?;
    
    // 检查会话状态
    if let Ok(status) = shell_session.status.read() {
        if !status.connected || !status.active {
            return Err(format!("Session {} is not connected or inactive", session_id));
        }
    } else {
        return Err(format!("Failed to get status for session {}", session_id));
    }
    
    let session = &shell_session.session;

    let sess = session.lock().map_err(|e| format!("[Session({})] Failed to lock session: {}", session_id, e))?;
    let sftp = sess.sftp().map_err(|e| format!("[Session({})] Unable to startup SFTP channel: {}", session_id, e))?;
    sftp.mkdir(Path::new(&path), 0o755)
        .map_err(|e| format!("[Session({})] Failed to create directory {}: {}", session_id, path, e))?;

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
    let sessions = ssh_state.sessions.read().map_err(|e| format!("Failed to read sessions: {}", e))?;
    let shell_session = sessions.get(&session_id).ok_or(format!("Session {} not found", session_id))?;
    
    // 检查会话状态
    if let Ok(status) = shell_session.status.read() {
        if !status.connected || !status.active {
            return Err(format!("Session {} is not connected or inactive", session_id));
        }
    } else {
        return Err(format!("Failed to get status for session {}", session_id));
    }
    
    let session = &shell_session.session;

    let sess = session.lock().map_err(|e| format!("[Session({})] Failed to lock session: {}", session_id, e))?;
    let sftp = sess.sftp().map_err(|e| format!("[Session({})] Unable to startup SFTP channel: {}", session_id, e))?;
    sftp.rename(Path::new(&old_path), Path::new(&new_path), None)
        .map_err(|e| format!("[Session({})] Failed to rename {} to {}: {}", session_id, old_path, new_path, e))?;

    Ok(())
}
