use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ssh2::{ErrorCode, FileStat, Session};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use super::status_parser::{
    parse_cpu_percent, parse_disks, parse_memory, parse_network_interfaces, parse_top_processes,
};
use crate::error::{AppError, AppResult};
use crate::models::{
    now_rfc3339, CommandExecutionResult, FetchServerStatusInput, MemoryStatus,
    NetworkInterfaceStatus, PtyOutputEvent, SftpDownloadInput, SftpDownloadPayload,
    SftpDeleteInput, SftpDownloadToLocalInput, SftpEntry, SftpEntryType, SftpFileContent, SftpListInput,
    SftpListResponse, SftpReadInput, SftpTransferEvent, SftpTransferResult, SftpUploadInput,
    SftpUploadWithProgressInput, SftpWriteInput, ShellSession, SshConfig,
};
use crate::state::{AppState, PtyCommand};

const DEFAULT_PTY_COLS: u16 = 120;
const DEFAULT_PTY_ROWS: u16 = 36;
const MAX_SESSION_LAST_OUTPUT_CHARS: usize = 16_000;
const PTY_IDLE_SLEEP_MS: u64 = 8;
const PTY_MAX_COMMANDS_PER_TICK: usize = 64;
const PTY_MAX_WRITE_OPS_PER_TICK: usize = 24;
const PTY_MAX_READ_CHUNKS_PER_TICK: usize = 8;
const SFTP_TRANSFER_EVENT: &str = "sftp-transfer";
const SFTP_TRANSFER_CHUNK_BYTES: usize = 64 * 1024;

/// Creates a shell session and starts a long-lived PTY worker for interactive terminal IO.
pub fn open_shell_session(
    state: Arc<AppState>,
    app: AppHandle,
    config_id: &str,
) -> AppResult<ShellSession> {
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
    let session_id = Uuid::new_v4().to_string();
    let session = ShellSession {
        id: session_id.clone(),
        config_id: config.id.clone(),
        config_name: config.name.clone(),
        current_dir: cwd,
        last_output: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    state.put_session(session.clone());
    start_pty_worker(Arc::clone(&state), app, session_id, ssh)?;
    Ok(session)
}

/// Closes and removes a shell session from runtime registry.
pub fn close_shell_session(state: &AppState, session_id: &str) -> AppResult<()> {
    match state.remove_session(session_id) {
        Ok(()) => Ok(()),
        Err(AppError::NotFound(_)) => Ok(()),
        Err(err) => Err(err),
    }
}

/// Writes raw input bytes into PTY shell channel.
pub fn pty_write_input(state: &AppState, session_id: &str, data: &str) -> AppResult<()> {
    if data.is_empty() {
        return Ok(());
    }
    state.send_pty_command(session_id, PtyCommand::Input(data.to_string()))
}

/// Resizes PTY shell dimensions to match frontend terminal viewport.
pub fn pty_resize(state: &AppState, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
    let safe_cols = cols.max(20);
    let safe_rows = rows.max(8);
    state.send_pty_command(
        session_id,
        PtyCommand::Resize {
            cols: safe_cols,
            rows: safe_rows,
        },
    )
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

/// Deletes one remote file or symlink through SFTP.
pub fn sftp_delete_entry(state: &AppState, input: SftpDeleteInput) -> AppResult<()> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.path);
    if remote_path == "/" {
        return Err(AppError::Validation(
            "refusing to delete the remote root directory".to_string(),
        ));
    }

    match input.entry_type {
        SftpEntryType::Directory => delete_remote_dir_recursive(&sftp, &remote_path)?,
        _ => sftp.unlink(Path::new(&remote_path))?,
    }
    Ok(())
}

/// Uploads base64 payload and emits chunk-level progress events.
pub fn sftp_upload_file_with_progress(
    state: &AppState,
    app: &AppHandle,
    input: SftpUploadWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let _transfer_guard = SftpTransferGuard::new(state, &input.transfer_id);
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let file_name = input
        .local_name
        .unwrap_or_else(|| extract_remote_file_name(&remote_path));
    let local_path = file_name.clone();
    let bytes = BASE64_STANDARD.decode(input.content_base64.as_bytes())?;
    let total_bytes = bytes.len() as u64;
    let mut transferred_bytes = 0_u64;

    emit_sftp_transfer_event(
        app,
        SftpTransferEvent {
            transfer_id: input.transfer_id.clone(),
            session_id: input.session_id.clone(),
            direction: "upload".to_string(),
            stage: "started".to_string(),
            remote_path: remote_path.clone(),
            local_path: Some(local_path.clone()),
            file_name: file_name.clone(),
            transferred_bytes,
            total_bytes: Some(total_bytes),
            percent: 0.0,
            message: None,
        },
    );

    let mut remote_file = match sftp.create(Path::new(&remote_path)) {
        Ok(file) => file,
        Err(error) => {
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "upload".to_string(),
                    stage: "failed".to_string(),
                    remote_path: remote_path.clone(),
                    local_path: Some(local_path),
                    file_name,
                    transferred_bytes,
                    total_bytes: Some(total_bytes),
                    percent: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(AppError::Ssh(error));
        }
    };

    for chunk in bytes.chunks(SFTP_TRANSFER_CHUNK_BYTES) {
        if state.is_sftp_transfer_cancelled(&input.transfer_id) {
            let _ = sftp.unlink(Path::new(&remote_path));
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "upload".to_string(),
                    stage: "cancelled".to_string(),
                    remote_path: remote_path.clone(),
                    local_path: Some(local_path.clone()),
                    file_name: file_name.clone(),
                    transferred_bytes,
                    total_bytes: Some(total_bytes),
                    percent: compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    message: Some("Transfer cancelled by user".to_string()),
                },
            );
            return Err(AppError::Runtime("transfer cancelled by user".to_string()));
        }

        if let Err(error) = remote_file.write_all(chunk) {
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "upload".to_string(),
                    stage: "failed".to_string(),
                    remote_path: remote_path.clone(),
                    local_path: Some(local_path.clone()),
                    file_name: file_name.clone(),
                    transferred_bytes,
                    total_bytes: Some(total_bytes),
                    percent: compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                    message: Some(error.to_string()),
                },
            );
            return Err(AppError::Io(error));
        }
        transferred_bytes += chunk.len() as u64;
        emit_sftp_transfer_event(
            app,
            SftpTransferEvent {
                transfer_id: input.transfer_id.clone(),
                session_id: input.session_id.clone(),
                direction: "upload".to_string(),
                stage: "progress".to_string(),
                remote_path: remote_path.clone(),
                local_path: Some(local_path.clone()),
                file_name: file_name.clone(),
                transferred_bytes,
                total_bytes: Some(total_bytes),
                percent: compute_transfer_percent(transferred_bytes, Some(total_bytes)),
                message: None,
            },
        );
    }

    emit_sftp_transfer_event(
        app,
        SftpTransferEvent {
            transfer_id: input.transfer_id.clone(),
            session_id: input.session_id.clone(),
            direction: "upload".to_string(),
            stage: "completed".to_string(),
            remote_path: remote_path.clone(),
            local_path: Some(local_path.clone()),
            file_name: file_name.clone(),
            transferred_bytes: total_bytes,
            total_bytes: Some(total_bytes),
            percent: 100.0,
            message: None,
        },
    );

    Ok(SftpTransferResult {
        transfer_id: input.transfer_id,
        direction: "upload".to_string(),
        remote_path,
        local_path,
        file_name,
        size: total_bytes,
    })
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

/// Downloads a remote file to a configured local directory and emits progress events.
pub fn sftp_download_file_to_local(
    state: &AppState,
    app: &AppHandle,
    input: SftpDownloadToLocalInput,
) -> AppResult<SftpTransferResult> {
    let _transfer_guard = SftpTransferGuard::new(state, &input.transfer_id);
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;
    let sftp = ssh.sftp()?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let file_name = extract_remote_file_name(&remote_path);
    let local_dir = normalize_local_dir(&input.local_dir)?;
    std::fs::create_dir_all(&local_dir)?;
    let local_path_buf = local_dir.join(&file_name);
    let local_path = local_path_buf.to_string_lossy().to_string();

    let mut remote_file = match sftp.open(Path::new(&remote_path)) {
        Ok(file) => file,
        Err(error) => {
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "download".to_string(),
                    stage: "failed".to_string(),
                    remote_path,
                    local_path: Some(local_path),
                    file_name,
                    transferred_bytes: 0,
                    total_bytes: None,
                    percent: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(AppError::Ssh(error));
        }
    };

    let total_bytes = sftp
        .stat(Path::new(&remote_path))
        .ok()
        .and_then(|stat| stat.size);
    let mut local_file = match File::create(&local_path_buf) {
        Ok(file) => file,
        Err(error) => {
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "download".to_string(),
                    stage: "failed".to_string(),
                    remote_path,
                    local_path: Some(local_path),
                    file_name,
                    transferred_bytes: 0,
                    total_bytes,
                    percent: 0.0,
                    message: Some(error.to_string()),
                },
            );
            return Err(AppError::Io(error));
        }
    };

    let mut transferred_bytes = 0_u64;
    emit_sftp_transfer_event(
        app,
        SftpTransferEvent {
            transfer_id: input.transfer_id.clone(),
            session_id: input.session_id.clone(),
            direction: "download".to_string(),
            stage: "started".to_string(),
            remote_path: remote_path.clone(),
            local_path: Some(local_path.clone()),
            file_name: file_name.clone(),
            transferred_bytes,
            total_bytes,
            percent: 0.0,
            message: None,
        },
    );

    let mut buffer = vec![0_u8; SFTP_TRANSFER_CHUNK_BYTES];
    loop {
        if state.is_sftp_transfer_cancelled(&input.transfer_id) {
            let _ = std::fs::remove_file(&local_path_buf);
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "download".to_string(),
                    stage: "cancelled".to_string(),
                    remote_path: remote_path.clone(),
                    local_path: Some(local_path.clone()),
                    file_name: file_name.clone(),
                    transferred_bytes,
                    total_bytes,
                    percent: compute_transfer_percent(transferred_bytes, total_bytes),
                    message: Some("Transfer cancelled by user".to_string()),
                },
            );
            return Err(AppError::Runtime("transfer cancelled by user".to_string()));
        }

        let read_size = match remote_file.read(&mut buffer) {
            Ok(size) => size,
            Err(error) => {
                emit_sftp_transfer_event(
                    app,
                    SftpTransferEvent {
                        transfer_id: input.transfer_id.clone(),
                        session_id: input.session_id.clone(),
                        direction: "download".to_string(),
                        stage: "failed".to_string(),
                        remote_path: remote_path.clone(),
                        local_path: Some(local_path.clone()),
                        file_name: file_name.clone(),
                        transferred_bytes,
                        total_bytes,
                        percent: compute_transfer_percent(transferred_bytes, total_bytes),
                        message: Some(error.to_string()),
                    },
                );
                return Err(AppError::Io(error));
            }
        };

        if read_size == 0 {
            break;
        }

        if let Err(error) = local_file.write_all(&buffer[..read_size]) {
            emit_sftp_transfer_event(
                app,
                SftpTransferEvent {
                    transfer_id: input.transfer_id.clone(),
                    session_id: input.session_id.clone(),
                    direction: "download".to_string(),
                    stage: "failed".to_string(),
                    remote_path: remote_path.clone(),
                    local_path: Some(local_path.clone()),
                    file_name: file_name.clone(),
                    transferred_bytes,
                    total_bytes,
                    percent: compute_transfer_percent(transferred_bytes, total_bytes),
                    message: Some(error.to_string()),
                },
            );
            return Err(AppError::Io(error));
        }

        transferred_bytes += read_size as u64;
        emit_sftp_transfer_event(
            app,
            SftpTransferEvent {
                transfer_id: input.transfer_id.clone(),
                session_id: input.session_id.clone(),
                direction: "download".to_string(),
                stage: "progress".to_string(),
                remote_path: remote_path.clone(),
                local_path: Some(local_path.clone()),
                file_name: file_name.clone(),
                transferred_bytes,
                total_bytes,
                percent: compute_transfer_percent(transferred_bytes, total_bytes),
                message: None,
            },
        );
    }

    let final_size = total_bytes.unwrap_or(transferred_bytes);
    emit_sftp_transfer_event(
        app,
        SftpTransferEvent {
            transfer_id: input.transfer_id.clone(),
            session_id: input.session_id.clone(),
            direction: "download".to_string(),
            stage: "completed".to_string(),
            remote_path: remote_path.clone(),
            local_path: Some(local_path.clone()),
            file_name: file_name.clone(),
            transferred_bytes: final_size,
            total_bytes: Some(final_size),
            percent: 100.0,
            message: None,
        },
    );

    Ok(SftpTransferResult {
        transfer_id: input.transfer_id,
        direction: "download".to_string(),
        remote_path,
        local_path,
        file_name,
        size: final_size,
    })
}

/// Returns a sensible default local download directory for current OS.
pub fn default_download_dir() -> String {
    resolve_default_download_dir().to_string_lossy().to_string()
}

/// Requests cancellation for a running SFTP transfer.
pub fn sftp_cancel_transfer(state: &AppState, transfer_id: &str) -> bool {
    state.cancel_sftp_transfer(transfer_id)
}

/// Collects server runtime metrics and updates session-bound cache.
pub fn fetch_server_status(
    state: &AppState,
    input: FetchServerStatusInput,
) -> AppResult<crate::models::ServerStatus> {
    let session = state.get_session(&input.session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let ssh = connect(&config)?;

    let top_output = run_channel_command(&ssh, "LANG=C top -bn1 | head -n 10")?.0;
    let cpu_percent = parse_cpu_percent(&top_output).unwrap_or(0.0);
    let memory = parse_memory(&top_output).unwrap_or(MemoryStatus {
        used_mb: 0.0,
        total_mb: 0.0,
        used_percent: 0.0,
    });

    let net_output = run_channel_command(&ssh, "cat /proc/net/dev")?.0;
    let network_interfaces = parse_network_interfaces(&net_output);
    let selected_interface = pick_selected_interface(&network_interfaces, input.selected_interface);
    let selected_interface_traffic = selected_interface.as_ref().and_then(|name| {
        network_interfaces
            .iter()
            .find(|item| &item.interface == name)
            .cloned()
    });

    let process_output =
        run_channel_command(&ssh, "ps -eo pid,pcpu,rss,comm --sort=-pcpu | head -n 5")?.0;
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
pub fn get_cached_server_status(
    state: &AppState,
    session_id: &str,
) -> Option<crate::models::ServerStatus> {
    state.get_cached_status(session_id)
}

struct SftpTransferGuard<'a> {
    state: &'a AppState,
    transfer_id: String,
}

impl<'a> SftpTransferGuard<'a> {
    fn new(state: &'a AppState, transfer_id: &str) -> Self {
        state.begin_sftp_transfer(transfer_id);
        Self {
            state,
            transfer_id: transfer_id.to_string(),
        }
    }
}

impl Drop for SftpTransferGuard<'_> {
    fn drop(&mut self) {
        self.state.clear_sftp_transfer(&self.transfer_id);
    }
}

fn emit_sftp_transfer_event(app: &AppHandle, event: SftpTransferEvent) {
    let _ = app.emit(SFTP_TRANSFER_EVENT, event);
}

fn compute_transfer_percent(transferred_bytes: u64, total_bytes: Option<u64>) -> f64 {
    match total_bytes {
        Some(0) | None => 0.0,
        Some(total) => {
            let ratio = (transferred_bytes as f64 / total as f64) * 100.0;
            ratio.clamp(0.0, 100.0)
        }
    }
}

fn extract_remote_file_name(remote_path: &str) -> String {
    remote_path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "download.bin".to_string())
}

fn normalize_local_dir(value: &str) -> AppResult<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "download directory cannot be empty".to_string(),
        ));
    }
    Ok(PathBuf::from(trimmed))
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

fn delete_remote_dir_recursive(sftp: &ssh2::Sftp, path: &str) -> AppResult<()> {
    let normalized_path = normalize_remote_path(path);
    let entries = sftp.readdir(Path::new(&normalized_path))?;

    for (entry_path, stat) in entries {
        let Some(name) = extract_entry_name(&entry_path.to_string_lossy()) else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }

        let child_path = join_remote_path(&normalized_path, &name);
        match stat_to_entry_type(&stat) {
            SftpEntryType::Directory => delete_remote_dir_recursive(sftp, &child_path)?,
            _ => sftp.unlink(Path::new(&child_path))?,
        }
    }

    sftp.rmdir(Path::new(&normalized_path))?;
    Ok(())
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

fn start_pty_worker(
    state: Arc<AppState>,
    app: AppHandle,
    session_id: String,
    ssh: Session,
) -> AppResult<()> {
    ssh.set_keepalive(true, 20);
    let mut channel = ssh.channel_session()?;
    channel.request_pty(
        "xterm-256color",
        None,
        Some((
            u32::from(DEFAULT_PTY_COLS),
            u32::from(DEFAULT_PTY_ROWS),
            0,
            0,
        )),
    )?;
    channel.shell()?;
    ssh.set_blocking(false);

    let (tx, rx) = mpsc::channel::<PtyCommand>();
    state.put_pty_channel(session_id.clone(), tx);
    append_server_ops_debug_log(
        state.as_ref(),
        "pty.worker.started",
        &session_id,
        format!(
            "keepalive_sec=20 cols={} rows={}",
            DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS
        ),
    );

    thread::spawn(move || {
        run_pty_worker(state, app, session_id, ssh, channel, rx);
    });

    Ok(())
}

fn run_pty_worker(
    state: Arc<AppState>,
    app: AppHandle,
    session_id: String,
    _ssh: Session,
    mut channel: ssh2::Channel,
    rx: mpsc::Receiver<PtyCommand>,
) {
    let mut io_buffer = [0_u8; 16_384];
    let mut keep_running = true;
    let mut pending_input = Vec::<u8>::new();
    let mut pending_input_offset = 0usize;

    while keep_running {
        let batch = drain_pty_command_batch(&rx, PTY_MAX_COMMANDS_PER_TICK);
        if batch.close_requested {
            append_server_ops_debug_log(
                state.as_ref(),
                "pty.worker.stop_requested",
                &session_id,
                "reason=close_command_or_channel_dropped",
            );
            break;
        }

        if let Some((cols, rows)) = batch.latest_resize {
            let _ = channel.request_pty_size(u32::from(cols), u32::from(rows), None, None);
        }

        if !batch.input.is_empty() {
            pending_input.extend_from_slice(&batch.input);
        }
        compact_pending_input(&mut pending_input, &mut pending_input_offset);

        let wrote_any = match pump_channel_input(
            &mut channel,
            &mut pending_input,
            &mut pending_input_offset,
            PTY_MAX_WRITE_OPS_PER_TICK,
        ) {
            Ok(written) => written > 0,
            Err(error) => {
                append_server_ops_debug_log(
                    state.as_ref(),
                    "pty.worker.write_failed",
                    &session_id,
                    error.to_string(),
                );
                break;
            }
        };

        let mut did_read = false;
        let mut read_chunks = 0usize;
        while read_chunks < PTY_MAX_READ_CHUNKS_PER_TICK {
            match channel.read(&mut io_buffer) {
                Ok(size) if size > 0 => {
                    did_read = true;
                    read_chunks += 1;
                    let chunk = String::from_utf8_lossy(&io_buffer[..size]).to_string();
                    append_session_output(&state, &session_id, &chunk);
                    emit_pty_output(&app, &session_id, &chunk);
                }
                Ok(_) => {
                    if channel.eof() {
                        keep_running = false;
                    }
                    break;
                }
                Err(err) if is_transient_pty_io_error(&err) => break,
                Err(err) => {
                    append_server_ops_debug_log(
                        state.as_ref(),
                        "pty.worker.read_failed",
                        &session_id,
                        err.to_string(),
                    );
                    keep_running = false;
                    break;
                }
            }
        }

        if channel.eof() {
            keep_running = false;
        }

        if !did_read && !wrote_any && batch.drained_messages == 0 {
            thread::sleep(Duration::from_millis(PTY_IDLE_SLEEP_MS));
        }
    }

    let _ = channel.close();
    let _ = channel.wait_close();
    append_server_ops_debug_log(
        state.as_ref(),
        "pty.worker.stopped",
        &session_id,
        "session_removed=true",
    );
    let _ = state.remove_session(&session_id);
}

fn emit_pty_output(app: &AppHandle, session_id: &str, chunk: &str) {
    let _ = app.emit(
        "pty-output",
        PtyOutputEvent {
            session_id: session_id.to_string(),
            chunk: chunk.to_string(),
        },
    );
}

fn append_session_output(state: &AppState, session_id: &str, chunk: &str) {
    let _ = state.mutate_session(session_id, |session| {
        session.last_output.push_str(chunk);
        trim_to_last_chars(&mut session.last_output, MAX_SESSION_LAST_OUTPUT_CHARS);
        session.updated_at = now_rfc3339();
    });
}

fn append_server_ops_debug_log(
    state: &AppState,
    event: &str,
    session_id: &str,
    detail: impl AsRef<str>,
) {
    let path = state.storage.data_dir().join("server_ops_debug.log");
    let line = format!(
        "{} [{}] session_id={} {}\n",
        now_rfc3339(),
        event,
        session_id,
        detail.as_ref()
    );

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn trim_to_last_chars(value: &mut String, max_chars: usize) {
    if max_chars == 0 {
        value.clear();
        return;
    }

    let total_chars = value.chars().count();
    if total_chars <= max_chars {
        return;
    }

    let drop_chars = total_chars - max_chars;
    let drop_bytes = value
        .char_indices()
        .nth(drop_chars)
        .map(|(index, _)| index)
        .unwrap_or(0);
    value.drain(..drop_bytes);
}

#[derive(Debug, Default, PartialEq, Eq)]
struct PtyCommandBatch {
    input: Vec<u8>,
    latest_resize: Option<(u16, u16)>,
    close_requested: bool,
    drained_messages: usize,
}

fn drain_pty_command_batch(
    rx: &mpsc::Receiver<PtyCommand>,
    max_messages: usize,
) -> PtyCommandBatch {
    let mut batch = PtyCommandBatch::default();
    let max_messages = max_messages.max(1);

    while batch.drained_messages < max_messages {
        match rx.try_recv() {
            Ok(PtyCommand::Input(data)) => {
                batch.drained_messages += 1;
                if !data.is_empty() {
                    batch.input.extend_from_slice(data.as_bytes());
                }
            }
            Ok(PtyCommand::Resize { cols, rows }) => {
                batch.drained_messages += 1;
                batch.latest_resize = Some((cols, rows));
            }
            Ok(PtyCommand::Close) => {
                batch.drained_messages += 1;
                batch.close_requested = true;
                break;
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                batch.close_requested = true;
                break;
            }
        }
    }

    batch
}

fn compact_pending_input(pending_input: &mut Vec<u8>, pending_offset: &mut usize) {
    if *pending_offset == 0 {
        return;
    }

    if *pending_offset >= pending_input.len() {
        pending_input.clear();
        *pending_offset = 0;
        return;
    }

    if *pending_offset >= 4096 && *pending_offset * 2 >= pending_input.len() {
        pending_input.drain(..*pending_offset);
        *pending_offset = 0;
    }
}

fn pump_channel_input(
    channel: &mut ssh2::Channel,
    pending_input: &mut Vec<u8>,
    pending_offset: &mut usize,
    max_write_ops: usize,
) -> AppResult<usize> {
    if *pending_offset >= pending_input.len() {
        pending_input.clear();
        *pending_offset = 0;
        return Ok(0);
    }

    let mut written_total = 0usize;
    let mut write_ops = 0usize;
    let max_write_ops = max_write_ops.max(1);

    while *pending_offset < pending_input.len() && write_ops < max_write_ops {
        match channel.write(&pending_input[*pending_offset..]) {
            Ok(0) => {
                if channel.eof() {
                    return Err(AppError::Runtime(
                        "pty channel closed while writing".to_string(),
                    ));
                }
                break;
            }
            Ok(size) => {
                *pending_offset += size;
                written_total += size;
                write_ops += 1;
            }
            Err(err) if is_transient_pty_io_error(&err) => break,
            Err(err) => return Err(AppError::Io(err)),
        }
    }

    compact_pending_input(pending_input, pending_offset);
    Ok(written_total)
}

fn is_transient_pty_io_error(err: &std::io::Error) -> bool {
    if matches!(
        err.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    ) {
        return true;
    }

    let message = err.to_string().to_ascii_lowercase();
    message.contains("would block")
        || message.contains("resource temporarily unavailable")
        || message.contains("timed out")
}

fn connect(config: &SshConfig) -> AppResult<Session> {
    let tcp = TcpStream::connect((config.host.as_str(), config.port))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(20)))?;
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(20)))?;

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|err| map_handshake_error(config, err))?;
    session.userauth_password(&config.username, &config.password)?;

    if !session.authenticated() {
        return Err(AppError::Runtime(format!(
            "authentication failed for {}@{}:{}",
            config.username, config.host, config.port
        )));
    }

    Ok(session)
}

fn map_handshake_error(config: &SshConfig, err: ssh2::Error) -> AppError {
    match err.code() {
        ErrorCode::Session(-8) => {
            let detail = err.message().trim();
            let detail_suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(" (detail: {detail})")
            };
            AppError::Runtime(format!(
                "SSH key exchange failed for {}@{}:{} (Session -8). Client and server could not negotiate compatible algorithms (KEX/Cipher/HostKey/MAC). Please check server-side sshd algorithm settings or use a host with modern SSH settings.{detail_suffix}",
                config.username, config.host, config.port
            ))
        }
        _ => AppError::Ssh(err),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_pty_command_batch_respects_limit_and_keeps_order() {
        let (tx, rx) = mpsc::channel::<PtyCommand>();
        tx.send(PtyCommand::Input("aa".to_string()))
            .expect("send input");
        tx.send(PtyCommand::Resize {
            cols: 120,
            rows: 40,
        })
        .expect("send resize");
        tx.send(PtyCommand::Input("bb".to_string()))
            .expect("send input");

        let first = drain_pty_command_batch(&rx, 2);
        assert_eq!(first.drained_messages, 2);
        assert_eq!(first.input, b"aa");
        assert_eq!(first.latest_resize, Some((120, 40)));
        assert!(!first.close_requested);

        let second = drain_pty_command_batch(&rx, 2);
        assert_eq!(second.drained_messages, 1);
        assert_eq!(second.input, b"bb");
        assert_eq!(second.latest_resize, None);
        assert!(!second.close_requested);
    }

    #[test]
    fn drain_pty_command_batch_stops_on_close() {
        let (tx, rx) = mpsc::channel::<PtyCommand>();
        tx.send(PtyCommand::Input("before".to_string()))
            .expect("send input");
        tx.send(PtyCommand::Close).expect("send close");
        tx.send(PtyCommand::Input("after".to_string()))
            .expect("send input");

        let batch = drain_pty_command_batch(&rx, 10);
        assert!(batch.close_requested);
        assert_eq!(batch.input, b"before");
        assert_eq!(batch.drained_messages, 2);
    }

    #[test]
    fn compact_pending_input_drops_consumed_prefix_when_large_enough() {
        let mut pending = vec![b'x'; 10_000];
        pending.extend_from_slice(b"tail");
        let mut offset = 10_000usize;

        compact_pending_input(&mut pending, &mut offset);

        assert_eq!(pending, b"tail");
        assert_eq!(offset, 0);
    }

    #[test]
    fn is_transient_pty_io_error_detects_timeout_and_wouldblock() {
        let timeout = std::io::Error::new(std::io::ErrorKind::TimedOut, "operation timed out");
        assert!(is_transient_pty_io_error(&timeout));

        let blocked = std::io::Error::new(
            std::io::ErrorKind::Other,
            "Resource temporarily unavailable",
        );
        assert!(is_transient_pty_io_error(&blocked));

        let broken = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broken pipe");
        assert!(!is_transient_pty_io_error(&broken));
    }
}
