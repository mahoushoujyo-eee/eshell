use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ssh2::{FileStat, Session};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    now_rfc3339, CommandExecutionResult, FetchServerStatusInput, MemoryStatus, NetworkInterfaceStatus,
    SftpDownloadPayload, SftpDownloadInput, SftpEntry, SftpEntryType, SftpFileContent, SftpListInput,
    SftpListResponse, SftpReadInput, SftpUploadInput, SftpWriteInput, ShellSession, SshConfig,
};
use crate::state::AppState;
use crate::status_parser::{
    parse_cpu_and_memory, parse_disks, parse_network_interfaces, parse_top_processes,
};

/// Creates a shell session after validating that SSH credentials are usable.
pub fn open_shell_session(state: &AppState, config_id: &str) -> AppResult<ShellSession> {
    let config = state.storage.find_ssh_config(config_id)?;
    let ssh = connect(&config)?;
    let (pwd_out, _, status) = run_channel_command(&ssh, "pwd")?;
    if status != 0 {
        return Err(AppError::Runtime(format!(
            "failed to initialize shell cwd for {}",
            config.name
        )));
    }

    let cwd = sanitize_cwd(pwd_out.trim());
    let now = now_rfc3339();
    let session = ShellSession {
        id: Uuid::new_v4().to_string(),
        config_id: config.id.clone(),
        config_name: config.name.clone(),
        current_dir: cwd,
        last_output: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    state.put_session(session.clone());
    Ok(session)
}

/// Closes and removes a shell session from runtime registry.
pub fn close_shell_session(state: &AppState, session_id: &str) -> AppResult<()> {
    state.remove_session(session_id)
}

/// Executes user command in context of a shell session while preserving tab-specific cwd.
pub fn execute_command(
    state: &AppState,
    session_id: &str,
    command: &str,
) -> AppResult<CommandExecutionResult> {
    let session = state.get_session(session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let started_at = now_rfc3339();
    let started_clock = Instant::now();

    let ssh = connect(&config)?;

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("command cannot be empty".to_string()));
    }

    let result = if let Some(target) = parse_cd_target(trimmed) {
        let cd_target = target.unwrap_or_else(|| "~".to_string());
        let cd_cmd = format!(
            "cd {} && cd {} && pwd",
            shell_quote(&session.current_dir),
            cd_target
        );
        let (stdout, stderr, exit_code) = run_channel_command(&ssh, &cd_cmd)?;
        if exit_code == 0 {
            let new_dir = sanitize_cwd(stdout.trim());
            state.mutate_session(session_id, |entry| {
                entry.current_dir = new_dir.clone();
                entry.last_output = stdout.trim().to_string();
                entry.updated_at = now_rfc3339();
            })?;
        }
        CommandExecutionResult {
            session_id: session_id.to_string(),
            command: command.to_string(),
            stdout,
            stderr,
            exit_code,
            current_dir: state.get_session(session_id)?.current_dir,
            started_at,
            finished_at: now_rfc3339(),
            duration_ms: started_clock.elapsed().as_millis(),
        }
    } else {
        let exec_cmd = format!("cd {} && {}", shell_quote(&session.current_dir), command);
        let (stdout, stderr, exit_code) = run_channel_command(&ssh, &exec_cmd)?;

        state.mutate_session(session_id, |entry| {
            entry.last_output = format_stdout_stderr(&stdout, &stderr);
            entry.updated_at = now_rfc3339();
        })?;

        CommandExecutionResult {
            session_id: session_id.to_string(),
            command: command.to_string(),
            stdout,
            stderr,
            exit_code,
            current_dir: session.current_dir,
            started_at,
            finished_at: now_rfc3339(),
            duration_ms: started_clock.elapsed().as_millis(),
        }
    };

    Ok(result)
}

/// Lists directory entries through SFTP.
pub fn sftp_list_dir(state: &AppState, input: SftpListInput) -> AppResult<SftpListResponse> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let requested_path = normalize_remote_path(&input.path);
    let raw_entries = sftp.readdir(Path::new(&requested_path))?;

    let mut entries = raw_entries
        .into_iter()
        .filter_map(|(path, stat)| {
            let name = extract_entry_name(&path.to_string_lossy())?;
            if name == "." || name == ".." {
                return None;
            }

            let kind = stat_to_entry_type(&stat);
            let full_path = join_remote_path(&requested_path, &name);
            Some(SftpEntry {
                name,
                path: full_path,
                entry_type: kind,
                size: stat.size.unwrap_or_default(),
                modified_at: stat.mtime,
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        let left_is_dir = left.entry_type == SftpEntryType::Directory;
        let right_is_dir = right.entry_type == SftpEntryType::Directory;
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(SftpListResponse {
        path: requested_path,
        entries,
    })
}

/// Reads remote file as UTF-8 text for in-app editing.
pub fn sftp_read_file(state: &AppState, input: SftpReadInput) -> AppResult<SftpFileContent> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.path);
    let mut file = sftp.open(Path::new(&remote_path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;

    Ok(SftpFileContent {
        path: remote_path,
        content: String::from_utf8_lossy(&bytes).to_string(),
    })
}

/// Writes text content to remote file path through SFTP.
pub fn sftp_write_file(state: &AppState, input: SftpWriteInput) -> AppResult<()> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.path);
    let mut file = sftp.create(Path::new(&remote_path))?;
    file.write_all(input.content.as_bytes())?;
    Ok(())
}

/// Uploads base64 payload to target remote path through SFTP.
pub fn sftp_upload_file(state: &AppState, input: SftpUploadInput) -> AppResult<()> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let mut file = sftp.create(Path::new(&remote_path))?;
    let bytes = BASE64_STANDARD.decode(input.content_base64.as_bytes())?;
    file.write_all(&bytes)?;
    Ok(())
}

/// Downloads remote file and returns base64-encoded bytes for frontend save flow.
pub fn sftp_download_file(
    state: &AppState,
    input: SftpDownloadInput,
) -> AppResult<SftpDownloadPayload> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let mut file = sftp.open(Path::new(&remote_path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;

    let file_name = remote_path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "download.bin".to_string());

    Ok(SftpDownloadPayload {
        path: remote_path,
        file_name,
        content_base64: BASE64_STANDARD.encode(&bytes),
        size: bytes.len(),
    })
}

/// Collects server runtime metrics and updates session-bound cache.
pub fn fetch_server_status(state: &AppState, input: FetchServerStatusInput) -> AppResult<crate::models::ServerStatus> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;

    let top_output = run_channel_command(&ssh, "LANG=C top -bn1 | head -n 5")?.0;
    let (cpu_percent, memory) = parse_cpu_and_memory(&top_output).unwrap_or((
        0.0,
        MemoryStatus {
            used_mb: 0.0,
            total_mb: 0.0,
            used_percent: 0.0,
        },
    ));

    let net_output = run_channel_command(&ssh, "cat /proc/net/dev")?.0;
    let network_interfaces = parse_network_interfaces(&net_output);
    let selected_interface = pick_selected_interface(&network_interfaces, input.selected_interface);
    let selected_interface_traffic = selected_interface
        .as_ref()
        .and_then(|name| network_interfaces.iter().find(|item| &item.interface == name).cloned());

    let process_output = run_channel_command(
        &ssh,
        "ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -n 5",
    )?
    .0;
    let top_processes = parse_top_processes(&process_output);

    let disk_output = run_channel_command(&ssh, "df -hP")?.0;
    let disks = parse_disks(&disk_output);

    let status = crate::models::ServerStatus {
        cpu_percent,
        memory,
        network_interfaces,
        selected_interface,
        selected_interface_traffic,
        top_processes,
        disks,
        fetched_at: now_rfc3339(),
    };

    state.put_cached_status(&input.session_id, status.clone());
    Ok(status)
}

/// Reads previously cached server status for current shell session.
pub fn get_cached_server_status(state: &AppState, session_id: &str) -> Option<crate::models::ServerStatus> {
    state.get_cached_status(session_id)
}

fn pick_selected_interface(
    all: &[NetworkInterfaceStatus],
    preferred: Option<String>,
) -> Option<String> {
    if let Some(preferred_name) = preferred {
        if all.iter().any(|item| item.interface == preferred_name) {
            return Some(preferred_name);
        }
    }
    all.first().map(|item| item.interface.clone())
}

fn stat_to_entry_type(stat: &FileStat) -> SftpEntryType {
    let Some(perm) = stat.perm else {
        return SftpEntryType::Other;
    };

    match perm & 0o170000 {
        0o040000 => SftpEntryType::Directory,
        0o100000 => SftpEntryType::File,
        0o120000 => SftpEntryType::Symlink,
        _ => SftpEntryType::Other,
    }
}

fn sanitize_cwd(value: &str) -> String {
    if value.trim().is_empty() {
        "/".to_string()
    } else {
        normalize_remote_path(value.trim())
    }
}

fn normalize_remote_path(value: &str) -> String {
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

fn join_remote_path(base: &str, name: &str) -> String {
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

fn extract_entry_name(raw_path: &str) -> Option<String> {
    let normalized = raw_path.replace('\\', "/");
    normalized
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(ToString::to_string)
}

fn parse_cd_target(command: &str) -> Option<Option<String>> {
    let trimmed = command.trim();
    if trimmed == "cd" {
        return Some(None);
    }
    trimmed
        .strip_prefix("cd ")
        .map(|target| Some(target.trim().to_string()))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn format_stdout_stderr(stdout: &str, stderr: &str) -> String {
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (true, true) => String::new(),
    }
}

fn connect(config: &SshConfig) -> AppResult<Session> {
    let tcp = TcpStream::connect((config.host.as_str(), config.port))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(20)))?;
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(20)))?;

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp);
    session.handshake()?;
    session.userauth_password(&config.username, &config.password)?;

    if !session.authenticated() {
        return Err(AppError::Runtime(format!(
            "authentication failed for {}@{}:{}",
            config.username, config.host, config.port
        )));
    }

    Ok(session)
}

fn run_channel_command(session: &Session, command: &str) -> AppResult<(String, String, i32)> {
    let mut channel = session.channel_session()?;
    channel.exec(command)?;

    let mut stdout = Vec::new();
    channel.read_to_end(&mut stdout)?;

    let mut stderr = Vec::new();
    channel.stderr().read_to_end(&mut stderr)?;

    channel.wait_close()?;
    let exit_code = channel.exit_status()?;

    Ok((
        String::from_utf8_lossy(&stdout).to_string(),
        String::from_utf8_lossy(&stderr).to_string(),
        exit_code,
    ))
}
