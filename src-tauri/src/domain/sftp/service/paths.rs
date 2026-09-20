use std::path::PathBuf;

use russh_sftp::protocol::FileType;
use uuid::Uuid;

use crate::common::error::{AppError, AppResult};
use crate::domain::sftp::model::SftpEntryType;

/// Returns a sensible default local download directory for current OS.
pub fn default_download_dir() -> String {
    resolve_default_download_dir().to_string_lossy().to_string()
}

pub(crate) fn entry_type_from_file_type(file_type: FileType) -> SftpEntryType {
    match file_type {
        FileType::Dir => SftpEntryType::Directory,
        FileType::File => SftpEntryType::File,
        FileType::Symlink => SftpEntryType::Symlink,
        FileType::Other => SftpEntryType::Other,
    }
}

pub(crate) fn extract_remote_file_name(remote_path: &str) -> String {
    remote_path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "download.bin".to_string())
}

pub(crate) fn normalize_local_dir(value: &str) -> AppResult<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "download directory cannot be empty".to_string(),
        ));
    }
    Ok(PathBuf::from(trimmed))
}

pub(crate) fn atomic_write_temp_path(remote_path: &str) -> String {
    atomic_write_temp_path_with_suffix(remote_path, &Uuid::new_v4().to_string())
}

pub(crate) fn atomic_write_temp_path_with_suffix(remote_path: &str, suffix: &str) -> String {
    let normalized = normalize_remote_path(remote_path);
    let trimmed = normalized.trim_end_matches('/');
    let (dir, file_name) = match trimmed.rsplit_once('/') {
        Some(("", name)) => ("/", name),
        Some((parent, name)) => (parent, name),
        None => ("", trimmed),
    };
    let temp_name = format!(".{file_name}.eshell-tmp-{suffix}");

    if dir.is_empty() {
        temp_name
    } else if dir == "/" {
        format!("/{temp_name}")
    } else {
        format!("{dir}/{temp_name}")
    }
}

pub(crate) fn renamed_remote_path(remote_path: &str, new_name: &str) -> AppResult<String> {
    let normalized = normalize_remote_path(remote_path);
    if normalized == "/" {
        return Err(AppError::Validation(
            "cannot rename the remote root directory".to_string(),
        ));
    }

    let name = new_name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(AppError::Validation(
            "new remote name must not be empty or contain path separators".to_string(),
        ));
    }

    let (parent, _) = normalized
        .rsplit_once('/')
        .ok_or_else(|| AppError::Validation("remote path is invalid".to_string()))?;
    if parent.is_empty() {
        Ok(format!("/{name}"))
    } else {
        Ok(format!("{parent}/{name}"))
    }
}

fn resolve_default_download_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(user_profile).join("Downloads");
        }
    } else if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Downloads");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("downloads")
}

/// Normalizes a remote POSIX path. Shared with `service` for cwd sanitization.
pub fn normalize_remote_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return "/".to_string();
    }

    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }

    if !normalized.starts_with('/') {
        normalized.insert(0, '/');
    }

    if normalized.len() > 1 {
        normalized = normalized.trim_end_matches('/').to_string();
    }

    if normalized.is_empty() {
        "/".to_string()
    } else {
        normalized
    }
}

pub(crate) fn join_remote_path(base: &str, name: &str) -> String {
    let normalized_base = normalize_remote_path(base);
    if normalized_base == "/" {
        format!("/{}", name)
    } else {
        format!(
            "{}/{}",
            normalized_base.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    }
}
