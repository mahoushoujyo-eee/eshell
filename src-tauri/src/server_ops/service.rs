use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use std::time::Instant;

use base64::engine::general_purpose::{
    STANDARD as BASE64_STANDARD, STANDARD_NO_PAD as BASE64_STANDARD_NO_PAD,
};
use base64::Engine;
use ssh2::{ErrorCode, FileStat, HashType, HostKeyType, RenameFlags, Session};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use super::status::{default_probes, ServerStatusDraft};
use crate::error::{AppError, AppResult};
use crate::models::{
    now_rfc3339, CommandExecutionResult, FetchServerStatusInput, PtyClosedEvent, PtyOutputEvent,
    SftpCreateInput, SftpDeleteInput, SftpDownloadInput, SftpDownloadPayload,
    SftpDownloadToLocalInput, SftpEntry, SftpEntryType, SftpFileContent, SftpListInput,
    SftpListResponse, SftpReadInput, SftpRenameInput, SftpTransferEvent, SftpTransferResult,
    SftpUploadInput, SftpUploadLocalWithProgressInput, SftpUploadWithProgressInput, SftpWriteInput,
    ShellSession, SshAuthType, SshConfig, SshHostKeyTrustChallenge, SshHostKeyTrustReason,
    SshKiPromptEvent, SshKiPromptItem,
};
use crate::state::{AppState, PtyCommand, SharedSshSession, SshSessionKind};

const DEFAULT_PTY_COLS: u16 = 120;
const DEFAULT_PTY_ROWS: u16 = 36;
const MAX_SESSION_LAST_OUTPUT_CHARS: usize = 16_000;
const PTY_IDLE_SLEEP_MS: u64 = 8;
const PTY_MAX_COMMANDS_PER_TICK: usize = 64;
const PTY_MAX_WRITE_OPS_PER_TICK: usize = 24;
const PTY_MAX_READ_CHUNKS_PER_TICK: usize = 8;
const SFTP_TRANSFER_EVENT: &str = "sftp-transfer";
const SFTP_TRANSFER_CHUNK_BYTES: usize = 64 * 1024;
const SFTP_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(200);
const SSH_CONNECT_TOTAL_TIMEOUT: Duration = Duration::from_secs(45);
const SSH_CONNECT_SLICE_TIMEOUT: Duration = Duration::from_millis(500);
const SSH_CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Upper bound for the libssh2 handshake (banner + key exchange) and non-interactive auth.
///
/// `TcpStream::set_read_timeout` does not bound these: libssh2 switches the socket to
/// non-blocking mode and polls using its own `api_timeout`, which defaults to 0 (wait forever).
const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_CONNECTION_CANCELLED_MESSAGE: &str = "SSH connection cancelled by user";
const SSH_HOST_KEY_TRUST_REQUIRED_PREFIX: &str = "SSH_HOST_KEY_TRUST_REQUIRED:";
const SSH_KI_PROMPT_EVENT: &str = "ssh-ki-prompt";
const SSH_KI_TIMEOUT: Duration = Duration::from_secs(300);

/// Creates a shell session and starts a long-lived PTY worker for interactive terminal IO.
pub fn open_shell_session(
    state: Arc<AppState>,
    app: AppHandle,
    config_id: &str,
    request_id: Option<&str>,
) -> AppResult<ShellSession> {
    if let Some(request_id) = request_id {
        state.begin_shell_connection(request_id);
    }

    let result = open_shell_session_inner(Arc::clone(&state), app, config_id, request_id);

    if let Some(request_id) = request_id {
        state.clear_shell_connection(request_id);
    }

    result
}

fn open_shell_session_inner(
    state: Arc<AppState>,
    app: AppHandle,
    config_id: &str,
    request_id: Option<&str>,
) -> AppResult<ShellSession> {
    let config = state.storage.find_ssh_config(config_id)?;
    let ssh = connect_with_app(
        &state,
        Some(&app),
        &config,
        request_id.map(|id| (&*state, id)),
    )?;
    let (pwd_out, _, status) = run_channel_command(&ssh, "pwd")?;
    if status != 0 {
        return Err(AppError::Runtime(format!(
            "failed to initialize shell cwd for {}",
            config.name
        )));
    }

    // A login shell that prints a banner on stdout would otherwise seed the
    // session with that banner as its working directory.
    let cwd = parse_pwd_output(&pwd_out).unwrap_or_else(|| "/".to_string());
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
///
/// Commands run on a cached, tab-bound SSH connection (`SshSessionKind::Exec`) rather than
/// a fresh TCP + handshake + auth round trip per command. One connection per command let
/// bursts of commands (agent loops, scripts, rapid submits) pile up unauthenticated
/// connections on the server and trip sshd `MaxStartups`, which surfaced to the user as
/// intermittent `Session(-8)` key exchange failures.
pub fn execute_command(
    state: &AppState,
    session_id: &str,
    command: &str,
) -> AppResult<CommandExecutionResult> {
    let session = state.get_session(session_id)?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("command cannot be empty".to_string()));
    }

    let started_at = now_rfc3339();
    let started_clock = Instant::now();

    let result = if let Some(target) = parse_cd_target(trimmed) {
        let cd_target = target.unwrap_or_else(|| "~".to_string());
        let cd_cmd = format!(
            "cd {} && cd {} && pwd",
            shell_quote(&session.current_dir),
            cd_target
        );
        let (stdout, stderr, exit_code) =
            run_session_command(state, None, session_id, SshSessionKind::Exec, &cd_cmd)?;
        if exit_code == 0 {
            match parse_pwd_output(&stdout) {
                Some(new_dir) => {
                    state.mutate_session(session_id, |entry| {
                        entry.current_dir = new_dir.clone();
                        entry.last_output = stdout.trim().to_string();
                        entry.updated_at = now_rfc3339();
                    })?;
                }
                None => {
                    // Keep the previous directory: adopting this output would be
                    // pasted into every later command in the session.
                    append_server_ops_debug_log(
                        state,
                        "shell.cd.unexpected_pwd_output",
                        session_id,
                        format!("bytes={} command={}", stdout.trim().len(), trimmed),
                    );
                    state.mutate_session(session_id, |entry| {
                        entry.last_output = stdout.trim().to_string();
                        entry.updated_at = now_rfc3339();
                    })?;
                }
            }
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
        let (stdout, stderr, exit_code) =
            run_session_command(state, None, session_id, SshSessionKind::Exec, &exec_cmd)?;

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
pub fn sftp_list_dir(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpListInput,
) -> AppResult<SftpListResponse> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
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
pub fn sftp_read_file(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpReadInput,
) -> AppResult<SftpFileContent> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
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
pub fn sftp_write_file(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpWriteInput,
) -> AppResult<()> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.path);
    let temp_path = atomic_write_temp_path(&remote_path);
    let temp_path_ref = Path::new(&temp_path);
    let remote_path_ref = Path::new(&remote_path);

    let write_result = (|| -> AppResult<()> {
        let mut file = sftp.create(temp_path_ref)?;
        file.write_all(input.content.as_bytes())?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = sftp.unlink(temp_path_ref);
        append_server_ops_debug_log(
            state,
            "sftp.write_file.write_failed",
            &input.session_id,
            format!(
                "path={} temp_path={} error={}",
                remote_path, temp_path, error
            ),
        );
        return Err(error);
    }

    finish_atomic_write_with_fallback(
        || {
            sftp.rename(temp_path_ref, remote_path_ref, atomic_write_rename_flags())
                .map_err(AppError::Ssh)
        },
        || {
            let mut file = sftp.create(remote_path_ref)?;
            file.write_all(input.content.as_bytes())?;
            Ok(())
        },
        || sftp.unlink(temp_path_ref).map_err(AppError::Ssh),
        |event, detail| append_server_ops_debug_log(state, event, &input.session_id, detail),
        &remote_path,
        &temp_path,
    )
}

/// Creates an empty remote file without overwriting an existing entry.
pub fn sftp_create_file(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpCreateInput,
) -> AppResult<()> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.path);
    ensure_creatable_remote_path(&sftp, &remote_path)?;
    let mut file = sftp.create(Path::new(&remote_path))?;
    file.write_all(b"")?;
    Ok(())
}

/// Creates one remote directory without overwriting an existing entry.
pub fn sftp_create_directory(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpCreateInput,
) -> AppResult<()> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.path);
    ensure_creatable_remote_path(&sftp, &remote_path)?;
    sftp.mkdir(Path::new(&remote_path), 0o755)?;
    Ok(())
}

/// Uploads base64 payload to target remote path through SFTP.
pub fn sftp_upload_file(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpUploadInput,
) -> AppResult<()> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let mut file = sftp.create(Path::new(&remote_path))?;
    let bytes = BASE64_STANDARD.decode(input.content_base64.as_bytes())?;
    file.write_all(&bytes)?;
    Ok(())
}

/// Deletes one remote file or symlink through SFTP.
pub fn sftp_delete_entry(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpDeleteInput,
) -> AppResult<()> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
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

/// Renames one remote entry within its current parent directory.
pub fn sftp_rename_entry(
    state: &AppState,
    app: Option<&AppHandle>,
    input: SftpRenameInput,
) -> AppResult<()> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.path);
    let target_path = renamed_remote_path(&remote_path, &input.new_name)?;
    if remote_path == target_path {
        return Ok(());
    }

    ensure_creatable_remote_path(&sftp, &target_path)?;
    sftp.rename(Path::new(&remote_path), Path::new(&target_path), None)?;
    Ok(())
}

/// Uploads base64 payload and emits chunk-level progress events.
pub fn sftp_upload_file_with_progress(
    state: &AppState,
    app: &AppHandle,
    input: SftpUploadWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let _transfer_guard = SftpTransferGuard::new(state, &input.transfer_id);
    let shared_ssh = operation_ssh_session(state, Some(app), &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let file_name = input
        .local_name
        .unwrap_or_else(|| extract_remote_file_name(&remote_path));
    let local_path = file_name.clone();
    let bytes = BASE64_STANDARD.decode(input.content_base64.as_bytes())?;
    let total_bytes = bytes.len() as u64;
    let mut transferred_bytes = 0_u64;
    let mut progress_throttle = TransferProgressThrottle::new(SFTP_PROGRESS_MIN_INTERVAL);

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
        if progress_throttle.should_emit(Instant::now(), false) {
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

/// Uploads a local file path by streaming it from disk into SFTP.
pub fn sftp_upload_local_file_with_progress(
    state: &AppState,
    app: &AppHandle,
    input: SftpUploadLocalWithProgressInput,
) -> AppResult<SftpTransferResult> {
    let _transfer_guard = SftpTransferGuard::new(state, &input.transfer_id);
    let local_path_buf = PathBuf::from(input.local_path.trim());
    let source = inspect_local_upload_source(&local_path_buf)?;
    let file_name = input
        .local_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| source.file_name.clone());
    let local_path = source.path.to_string_lossy().to_string();
    let total_bytes = source.total_bytes;
    let mut local_file = File::open(&source.path)?;

    let shared_ssh = operation_ssh_session(state, Some(app), &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
    let remote_path = normalize_remote_path(&input.remote_path);
    let mut transferred_bytes = 0_u64;
    let mut progress_throttle = TransferProgressThrottle::new(SFTP_PROGRESS_MIN_INTERVAL);

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

    let mut buffer = vec![0_u8; SFTP_TRANSFER_CHUNK_BYTES];
    loop {
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

        let read_size = match local_file.read(&mut buffer) {
            Ok(size) => size,
            Err(error) => {
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
                let _ = sftp.unlink(Path::new(&remote_path));
                return Err(AppError::Io(error));
            }
        };

        if read_size == 0 {
            break;
        }

        if let Err(error) = remote_file.write_all(&buffer[..read_size]) {
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
            let _ = sftp.unlink(Path::new(&remote_path));
            return Err(AppError::Io(error));
        }

        transferred_bytes += read_size as u64;
        if progress_throttle.should_emit(Instant::now(), false) {
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
    app: Option<&AppHandle>,
    input: SftpDownloadInput,
) -> AppResult<SftpDownloadPayload> {
    let shared_ssh = operation_ssh_session(state, app, &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
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
    let shared_ssh = operation_ssh_session(state, Some(app), &input.session_id)?;
    let ssh = lock_ssh_session(&shared_ssh)?;
    let sftp = open_operation_sftp(state, &input.session_id, &shared_ssh, &ssh)?;
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
    let mut progress_throttle = TransferProgressThrottle::new(SFTP_PROGRESS_MIN_INTERVAL);
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
        if progress_throttle.should_emit(Instant::now(), false) {
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
///
/// Each metric is a probe that carries its own command; adding one means adding
/// a module under `status`, not editing this function.
pub fn fetch_server_status(
    state: &AppState,
    app: Option<&AppHandle>,
    input: FetchServerStatusInput,
) -> AppResult<crate::models::ServerStatus> {
    let mut draft = ServerStatusDraft::default();

    for probe in default_probes() {
        let output = match run_session_command(
            state,
            app,
            &input.session_id,
            SshSessionKind::Operation,
            &probe.command(),
        ) {
            Ok(result) => result.0,
            Err(err) => {
                // Name the metric that broke; the error alone only says a
                // command failed, and five of them run per poll.
                append_server_ops_debug_log(
                    state,
                    "status.probe.failed",
                    &input.session_id,
                    format!("probe={} error={err}", probe.id()),
                );
                return Err(err);
            }
        };
        probe.apply(&output, &mut draft);
    }

    let status = draft.into_status(input.selected_interface);
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

struct TransferProgressThrottle {
    min_interval: Duration,
    last_emit_at: Option<Instant>,
}

impl TransferProgressThrottle {
    fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_emit_at: None,
        }
    }

    fn should_emit(&mut self, now: Instant, force: bool) -> bool {
        if force {
            self.last_emit_at = Some(now);
            return true;
        }

        match self.last_emit_at {
            Some(last_emit_at)
                if now.saturating_duration_since(last_emit_at) < self.min_interval =>
            {
                false
            }
            _ => {
                self.last_emit_at = Some(now);
                true
            }
        }
    }
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

fn atomic_write_temp_path(remote_path: &str) -> String {
    atomic_write_temp_path_with_suffix(remote_path, &Uuid::new_v4().to_string())
}

fn atomic_write_rename_flags() -> Option<RenameFlags> {
    Some(RenameFlags::OVERWRITE)
}

fn finish_atomic_write_with_fallback<R, D, U, L>(
    mut rename_temp: R,
    mut direct_write_target: D,
    mut unlink_temp: U,
    mut log_failure: L,
    remote_path: &str,
    temp_path: &str,
) -> AppResult<()>
where
    R: FnMut() -> AppResult<()>,
    D: FnMut() -> AppResult<()>,
    U: FnMut() -> AppResult<()>,
    L: FnMut(&str, String),
{
    if let Err(error) = rename_temp() {
        log_failure(
            "sftp.write_file.rename_failed",
            format!(
                "path={} temp_path={} error={}",
                remote_path, temp_path, error
            ),
        );

        match direct_write_target() {
            Ok(()) => {
                if let Err(cleanup_error) = unlink_temp() {
                    log_failure(
                        "sftp.write_file.temp_cleanup_failed",
                        format!(
                            "path={} temp_path={} error={}",
                            remote_path, temp_path, cleanup_error
                        ),
                    );
                }
                log_failure(
                    "sftp.write_file.direct_write_fallback_succeeded",
                    format!("path={} temp_path={}", remote_path, temp_path),
                );
                return Ok(());
            }
            Err(fallback_error) => {
                log_failure(
                    "sftp.write_file.direct_write_fallback_failed",
                    format!(
                        "path={} temp_path={} error={}",
                        remote_path, temp_path, fallback_error
                    ),
                );
                return Err(fallback_error);
            }
        }
    }

    Ok(())
}

fn atomic_write_temp_path_with_suffix(remote_path: &str, suffix: &str) -> String {
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

fn renamed_remote_path(remote_path: &str, new_name: &str) -> AppResult<String> {
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

#[derive(Debug)]
struct LocalUploadSource {
    path: PathBuf,
    file_name: String,
    total_bytes: u64,
}

fn inspect_local_upload_source(path: &Path) -> AppResult<LocalUploadSource> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(AppError::Validation(format!(
            "local upload path is not a regular file: {}",
            path.display()
        )));
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| {
            AppError::Validation(format!(
                "local upload path has no file name: {}",
                path.display()
            ))
        })?;

    Ok(LocalUploadSource {
        path: path.to_path_buf(),
        file_name,
        total_bytes: metadata.len(),
    })
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

fn ensure_creatable_remote_path(sftp: &ssh2::Sftp, path: &str) -> AppResult<()> {
    let normalized_path = normalize_remote_path(path);
    if normalized_path == "/" {
        return Err(AppError::Validation(
            "refusing to create the remote root path".to_string(),
        ));
    }
    if sftp.stat(Path::new(&normalized_path)).is_ok() {
        return Err(AppError::Validation(format!(
            "remote path already exists: {normalized_path}"
        )));
    }
    Ok(())
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

/// Recognizes a command whose *only* effect is changing directory, so the
/// session's tracked cwd can follow it.
///
/// `Some(None)` is a bare `cd` (go home), `Some(Some(target))` is `cd <target>`,
/// and `None` means "not a plain cd" — the caller runs it as an ordinary
/// command instead.
///
/// Anything that chains or redirects (`&&`, `||`, `;`, `|`, `&`, `<`, `>`, a
/// newline) is deliberately rejected. Matching on the `cd ` prefix alone meant
/// `cd /srv/app && docker compose ...` was treated as a directory change, and
/// the whole chain's stdout was then stored as the session's working
/// directory. Every later command is built as `cd '<current_dir>' && ...`, so
/// one such command left the tab failing with "File name too long" until it
/// was closed.
fn parse_cd_target(command: &str) -> Option<Option<String>> {
    let trimmed = command.trim();
    if trimmed == "cd" {
        return Some(None);
    }

    let target = trimmed.strip_prefix("cd ")?.trim();
    if target.is_empty() {
        return Some(None);
    }
    if !is_single_cd_target(target) {
        return None;
    }
    Some(Some(target.to_string()))
}

/// Whether a `cd` argument can still hold a second command.
///
/// A newline is a command separator too, and is covered by the control-char
/// check. Expansions (`~`, `$HOME`, globs) stay allowed: they only ever produce
/// the directory name, so `pwd` remains the single thing written to stdout.
fn is_single_cd_target(target: &str) -> bool {
    !target
        .chars()
        .any(|ch| matches!(ch, '&' | '|' | ';' | '<' | '>') || ch.is_control())
}

/// Linux caps a path at PATH_MAX; nothing longer can be a real directory.
const MAX_REMOTE_CWD_LEN: usize = 4096;

/// Reads the output of a `pwd` as the session's new working directory.
///
/// Returns `None` unless the output really is one absolute path. The caller
/// then keeps the previous directory rather than adopting the text, which is
/// what stops a surprising command from bricking the tab: `current_dir` is
/// pasted into every later command, and there is no way to reset it from the
/// UI short of closing the session.
///
/// Note this rejects rather than repairs. `sanitize_cwd` alone was not enough:
/// it prepends a `/` to whatever it is given, so arbitrary command output came
/// back out shaped like a path.
fn parse_pwd_output(output: &str) -> Option<String> {
    let trimmed = output.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_REMOTE_CWD_LEN {
        return None;
    }
    if !trimmed.starts_with('/') {
        return None;
    }
    if trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(sanitize_cwd(trimmed))
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
    ssh: Session,
    mut channel: ssh2::Channel,
    rx: mpsc::Receiver<PtyCommand>,
) {
    let mut io_buffer = [0_u8; 16_384];
    let mut keep_running = true;
    let mut pending_input = Vec::<u8>::new();
    let mut pending_input_offset = 0usize;
    // `None` means the worker was asked to stop (user close / channel replaced)
    // and the exit stays silent; any other exit reports a disconnect event.
    let mut close_reason: Option<String> = None;

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

        // libssh2 only sends the configured keepalive when we pump it; without
        // this, a silently dropped connection (NAT/firewall idle timeout) is
        // never detected — reads stay WouldBlock forever and the terminal
        // freezes without any signal.
        if let Err(err) = ssh.keepalive_send() {
            if !is_transient_ssh_error(&err) {
                append_server_ops_debug_log(
                    state.as_ref(),
                    "pty.worker.keepalive_failed",
                    &session_id,
                    err.to_string(),
                );
                close_reason = Some(format!("connection_lost: {err}"));
                break;
            }
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
                close_reason = Some(format!("write_failed: {error}"));
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
                        close_reason.get_or_insert_with(|| "eof".to_string());
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
                    close_reason = Some(format!("read_failed: {err}"));
                    break;
                }
            }
        }

        if channel.eof() {
            keep_running = false;
            close_reason.get_or_insert_with(|| "eof".to_string());
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

    if let Some(reason) = close_reason {
        append_server_ops_debug_log(
            state.as_ref(),
            "pty.worker.disconnected",
            &session_id,
            &reason,
        );
        emit_pty_closed(&app, &session_id, &reason);
    }
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

fn emit_pty_closed(app: &AppHandle, session_id: &str, reason: &str) {
    let _ = app.emit(
        "pty-closed",
        PtyClosedEvent {
            session_id: session_id.to_string(),
            reason: reason.to_string(),
        },
    );
}

/// `keepalive_send` on a non-blocking session may legitimately return EAGAIN;
/// anything else means the transport is gone.
fn is_transient_ssh_error(err: &ssh2::Error) -> bool {
    const LIBSSH2_ERROR_EAGAIN: i32 = -37;
    matches!(err.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN))
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

fn operation_ssh_session(
    state: &AppState,
    app: Option<&AppHandle>,
    session_id: &str,
) -> AppResult<SharedSshSession> {
    cached_ssh_session(state, app, session_id, SshSessionKind::Operation)
}

/// Returns the cached SSH connection of `kind` for a shell tab, connecting on first use.
fn cached_ssh_session(
    state: &AppState,
    app: Option<&AppHandle>,
    session_id: &str,
    kind: SshSessionKind,
) -> AppResult<SharedSshSession> {
    let session = state.get_session(session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    state.get_or_insert_ssh_session(session_id, kind, || {
        let ssh = connect_with_app(state, app, &config, None)?;
        ssh.set_keepalive(true, 20);
        Ok(ssh)
    })
}

fn lock_ssh_session(session: &SharedSshSession) -> AppResult<std::sync::MutexGuard<'_, Session>> {
    session
        .lock()
        .map_err(|_| AppError::Runtime("cached SSH session lock poisoned".to_string()))
}

/// Opens an SFTP channel on the cached operation session.
///
/// Opening the channel is the first thing that touches the socket, so a connection the
/// server has since dropped (idle timeout, sshd restart, network reset) surfaces here.
/// Such a connection is evicted so the next operation reconnects, instead of the tab
/// failing every SFTP action until it is closed. The current operation is not retried:
/// the caller may be mid-way through non-idempotent work.
fn open_operation_sftp(
    state: &AppState,
    session_id: &str,
    shared: &SharedSshSession,
    ssh: &Session,
) -> AppResult<ssh2::Sftp> {
    ssh.sftp().map_err(|err| {
        let err = AppError::Ssh(err);
        if is_stale_connection_error(&err) {
            let evicted = state.evict_ssh_session(session_id, SshSessionKind::Operation, shared);
            append_server_ops_debug_log(
                state,
                "ssh.operation_session.stale",
                session_id,
                format!("evicted={evicted} error={err}"),
            );
        }
        err
    })
}

/// Runs one non-interactive command on the cached SSH connection of `kind`.
///
/// If the cached connection turns out to be dead when the exec channel is opened, it is
/// evicted and rebuilt once, then the command is sent again. The retry happens only on
/// channel-open failure, i.e. before the command ever reached the server, so a
/// non-idempotent command is never executed twice. A failure after the command was sent
/// is returned as-is, still evicting the dead connection so the next call reconnects.
fn run_session_command(
    state: &AppState,
    app: Option<&AppHandle>,
    session_id: &str,
    kind: SshSessionKind,
    command: &str,
) -> AppResult<(String, String, i32)> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let shared = cached_ssh_session(state, app, session_id, kind)?;
        let ssh = lock_ssh_session(&shared)?;

        let channel = match open_exec_channel(&ssh, command) {
            Ok(channel) => channel,
            Err(err) => {
                if !is_stale_connection_error(&err) {
                    return Err(err);
                }
                drop(ssh);
                let evicted = state.evict_ssh_session(session_id, kind, &shared);
                append_server_ops_debug_log(
                    state,
                    "ssh.session_command.stale",
                    session_id,
                    format!("kind={kind:?} attempt={attempt} evicted={evicted} error={err}"),
                );
                if attempt >= 2 {
                    return Err(err);
                }
                continue;
            }
        };

        return match collect_channel_output(channel) {
            Ok(output) => Ok(output),
            Err(err) => {
                if is_stale_connection_error(&err) {
                    drop(ssh);
                    state.evict_ssh_session(session_id, kind, &shared);
                }
                Err(err)
            }
        };
    }
}

/// Whether an error means the underlying SSH transport is gone, as opposed to a remote
/// command exiting non-zero, a missing path, or a permission problem.
fn is_stale_connection_error(err: &AppError) -> bool {
    match err {
        AppError::Ssh(ssh_err) => matches!(
            ssh_err.code(),
            ErrorCode::Session(
                // SOCKET_SEND / SOCKET_DISCONNECT / SOCKET_RECV / BAD_SOCKET
                -7 | -13 | -43 | -45
                // TIMEOUT / SOCKET_TIMEOUT
                | -9 | -30
                // BANNER_RECV / BANNER_SEND / PROTO / DECRYPT / INVALID_MAC:
                // the stream is corrupted or the peer went away mid-packet.
                | -2 | -3 | -14 | -12 | -4
            )
        ),
        AppError::Io(io_err) => matches!(
            io_err.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::NotConnected
                | std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

fn connect_with_app(
    state: &AppState,
    app: Option<&AppHandle>,
    config: &SshConfig,
    cancellation: Option<(&AppState, &str)>,
) -> AppResult<Session> {
    let tcp = if let Some(jump_id) = config.jump_host_id.as_deref().filter(|s| !s.is_empty()) {
        let jump_config = state
            .storage
            .find_ssh_config(jump_id)
            .map_err(|_| AppError::Runtime(format!("jump host config {jump_id} not found")))?;
        open_jump_host_stream(
            state,
            app,
            &jump_config,
            &config.host,
            config.port,
            cancellation,
        )?
    } else {
        let stream = connect_tcp_with_cancellation(config, cancellation)?;
        stream.set_read_timeout(Some(Duration::from_secs(20)))?;
        stream.set_write_timeout(Some(Duration::from_secs(20)))?;
        stream
    };

    let mut session = Session::new()?;
    session.set_tcp_stream(tcp);
    // Bound the handshake. Without this a peer that stalls mid key exchange hangs the
    // caller forever, because libssh2 polls on its own api_timeout (0 means no limit).
    session.set_timeout(handshake_timeout_ms());
    check_shell_connection_cancelled(cancellation)?;
    session
        .handshake()
        .map_err(|err| map_handshake_error(config, err))?;
    check_shell_connection_cancelled(cancellation)?;
    verify_host_key_trust(state, config, &session)?;
    check_shell_connection_cancelled(cancellation)?;
    authenticate_session(state, app, config, &mut session)?;

    if !session.authenticated() {
        return Err(AppError::Runtime(format!(
            "authentication failed for {}@{}:{}",
            config.username, config.host, config.port
        )));
    }

    // Restore the libssh2 default for everything downstream. Long-running commands,
    // large SFTP transfers and the PTY worker must not inherit the handshake deadline.
    session.set_timeout(0);
    Ok(session)
}

fn handshake_timeout_ms() -> u32 {
    u32::try_from(SSH_HANDSHAKE_TIMEOUT.as_millis()).unwrap_or(u32::MAX)
}

#[allow(dead_code)]
fn connect_with_cancellation(
    state: &AppState,
    config: &SshConfig,
    cancellation: Option<(&AppState, &str)>,
) -> AppResult<Session> {
    connect_with_app(state, None, config, cancellation)
}

fn open_jump_host_stream(
    state: &AppState,
    app: Option<&AppHandle>,
    jump_config: &SshConfig,
    target_host: &str,
    target_port: u16,
    cancellation: Option<(&AppState, &str)>,
) -> AppResult<TcpStream> {
    let jump_session = connect_with_app(state, app, jump_config, cancellation)?;
    jump_session.set_blocking(true);

    let channel = jump_session
        .channel_direct_tcpip(target_host, target_port, Some(("127.0.0.1", 0)))
        .map_err(|err| {
            AppError::Runtime(format!(
                "failed to open jump channel to {target_host}:{target_port}: {err}"
            ))
        })?;

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let local_port = listener.local_addr()?.port();

    thread::spawn(move || {
        let Ok((local_stream, _)) = listener.accept() else {
            return;
        };
        let Ok(mut local_w) = local_stream.try_clone() else {
            return;
        };
        let mut local_r = local_stream;

        let channel_arc = Arc::new(Mutex::new(channel));
        let channel_arc2 = Arc::clone(&channel_arc);

        let ch_to_local = thread::spawn(move || {
            let mut buf = [0u8; 32_768];
            loop {
                let n = {
                    let mut ch = match channel_arc2.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    match ch.read(&mut buf) {
                        Ok(n) => n,
                        Err(_) => 0,
                    }
                };
                if n == 0 {
                    break;
                }
                if local_w.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        });

        let _keep_alive = jump_session;
        let mut buf = [0u8; 32_768];
        loop {
            let n = match local_r.read(&mut buf) {
                Ok(n) => n,
                Err(_) => 0,
            };
            if n == 0 {
                break;
            }
            let mut ch = match channel_arc.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            if ch.write_all(&buf[..n]).is_err() {
                break;
            }
        }
        let _ = ch_to_local.join();
    });

    let stream = TcpStream::connect(format!("127.0.0.1:{local_port}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(Duration::from_secs(20)))?;
    Ok(stream)
}

fn verify_host_key_trust(state: &AppState, config: &SshConfig, session: &Session) -> AppResult<()> {
    let host_key = extract_host_key_fingerprint(session).ok_or_else(|| {
        AppError::Runtime(format!(
            "SSH host key is unavailable for {}:{}",
            config.host, config.port
        ))
    })?;

    match state.storage.find_known_host(&config.host, config.port) {
        Some(known_host) if known_host.fingerprint == host_key.fingerprint => Ok(()),
        Some(known_host) => Err(host_key_trust_required(SshHostKeyTrustChallenge {
            reason: SshHostKeyTrustReason::Changed,
            host: config.host.clone(),
            port: config.port,
            key_type: host_key.key_type,
            fingerprint: host_key.fingerprint,
            trusted_fingerprint: Some(known_host.fingerprint),
        })),
        None => Err(host_key_trust_required(SshHostKeyTrustChallenge {
            reason: SshHostKeyTrustReason::Unknown,
            host: config.host.clone(),
            port: config.port,
            key_type: host_key.key_type,
            fingerprint: host_key.fingerprint,
            trusted_fingerprint: None,
        })),
    }
}

fn authenticate_session(
    state: &AppState,
    app: Option<&AppHandle>,
    config: &SshConfig,
    session: &mut Session,
) -> AppResult<()> {
    match config.auth_type {
        SshAuthType::Password => authenticate_with_password(config, session),
        SshAuthType::PrivateKey => {
            let key_path = Path::new(config.private_key_path.trim());
            if config.private_key_path.trim().is_empty() {
                return Err(AppError::Validation(
                    "private key path cannot be empty for private key authentication".to_string(),
                ));
            }
            if !key_path.exists() {
                return Err(AppError::Validation(format!(
                    "private key file does not exist: {}",
                    key_path.display()
                )));
            }

            let passphrase = if config.private_key_passphrase.is_empty() {
                None
            } else {
                Some(config.private_key_passphrase.as_str())
            };
            let key_result =
                session.userauth_pubkey_file(&config.username, None, key_path, passphrase);

            match key_result {
                Ok(()) => Ok(()),
                Err(err) if config.use_password_fallback && !config.password.is_empty() => {
                    authenticate_with_password(config, session)
                        .map_err(|fallback_err| map_key_auth_error(config, fallback_err))?;
                    if session.authenticated() {
                        Ok(())
                    } else {
                        Err(map_key_auth_error(config, AppError::Ssh(err)))
                    }
                }
                Err(err) => Err(map_key_auth_error(config, AppError::Ssh(err))),
            }
        }
        SshAuthType::KeyboardInteractive => {
            let app = app.ok_or_else(|| {
                AppError::Runtime("keyboard-interactive auth requires an app handle".to_string())
            })?;
            let request_id = Uuid::new_v4().to_string();
            let mut prompter = FrontendKiPrompter {
                state,
                app,
                request_id: request_id.clone(),
            };
            // The prompt callback blocks for up to SSH_KI_TIMEOUT waiting for the user,
            // and libssh2 measures api_timeout from the moment the API call is entered,
            // so the handshake deadline must not apply here.
            session.set_timeout(0);
            session
                .userauth_keyboard_interactive(&config.username, &mut prompter)
                .map_err(|err| {
                    state.clear_ki_pending(&request_id);
                    AppError::Runtime(format!(
                        "keyboard-interactive authentication failed for {}@{}:{}: {err}",
                        config.username, config.host, config.port
                    ))
                })
        }
    }
}

struct FrontendKiPrompter<'a> {
    state: &'a AppState,
    app: &'a AppHandle,
    request_id: String,
}

impl<'a> ssh2::KeyboardInteractivePrompt for FrontendKiPrompter<'a> {
    fn prompt(
        &mut self,
        username: &str,
        instructions: &str,
        prompts: &[ssh2::Prompt<'_>],
    ) -> Vec<String> {
        if prompts.is_empty() {
            return vec![];
        }

        let (tx, rx) = mpsc::channel::<Vec<String>>();
        self.state.put_ki_pending(&self.request_id, tx);

        let event = SshKiPromptEvent {
            request_id: self.request_id.clone(),
            username: username.to_string(),
            instructions: instructions.to_string(),
            prompts: prompts
                .iter()
                .map(|p| SshKiPromptItem {
                    text: p.text.to_string(),
                    echo: p.echo,
                })
                .collect(),
        };

        if self.app.emit(SSH_KI_PROMPT_EVENT, &event).is_err() {
            self.state.clear_ki_pending(&self.request_id);
            return vec![String::new(); prompts.len()];
        }

        match rx.recv_timeout(SSH_KI_TIMEOUT) {
            Ok(responses) => {
                if responses.len() == prompts.len() {
                    responses
                } else {
                    let mut r = responses;
                    r.resize(prompts.len(), String::new());
                    r
                }
            }
            Err(_) => {
                self.state.clear_ki_pending(&self.request_id);
                vec![String::new(); prompts.len()]
            }
        }
    }
}

/// Delivers keyboard-interactive responses from frontend to waiting auth thread.
pub fn ssh_ki_respond(state: &AppState, request_id: &str, responses: Vec<String>) -> AppResult<()> {
    state.respond_ki(request_id, responses)
}

fn authenticate_with_password(config: &SshConfig, session: &mut Session) -> AppResult<()> {
    if config.password.is_empty() {
        return Err(AppError::Validation(
            "password cannot be empty for password authentication".to_string(),
        ));
    }
    session.userauth_password(&config.username, &config.password)?;
    Ok(())
}

struct HostKeyFingerprint {
    key_type: String,
    fingerprint: String,
}

fn extract_host_key_fingerprint(session: &Session) -> Option<HostKeyFingerprint> {
    let (_, key_type) = session.host_key()?;
    let hash = session.host_key_hash(HashType::Sha256)?;
    Some(HostKeyFingerprint {
        key_type: normalize_host_key_type(key_type),
        fingerprint: format!("SHA256:{}", BASE64_STANDARD_NO_PAD.encode(hash)),
    })
}

fn normalize_host_key_type(key_type: HostKeyType) -> String {
    match key_type {
        HostKeyType::Rsa => "ssh-rsa".to_string(),
        HostKeyType::Dss => "ssh-dss".to_string(),
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256".to_string(),
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384".to_string(),
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521".to_string(),
        HostKeyType::Ed25519 => "ssh-ed25519".to_string(),
        _ => format!("{key_type:?}"),
    }
}

fn host_key_trust_required(challenge: SshHostKeyTrustChallenge) -> AppError {
    let payload = serde_json::to_string(&challenge).unwrap_or_else(|_| "{}".to_string());
    AppError::Runtime(format!("{SSH_HOST_KEY_TRUST_REQUIRED_PREFIX}{payload}"))
}

fn map_key_auth_error(config: &SshConfig, err: AppError) -> AppError {
    let detail = err.to_string();
    AppError::Runtime(format!(
        "private key authentication failed for {}@{}:{}: {detail}. Check the private key path and passphrase.",
        config.username, config.host, config.port
    ))
}

fn connect_tcp_with_cancellation(
    config: &SshConfig,
    cancellation: Option<(&AppState, &str)>,
) -> AppResult<TcpStream> {
    let addresses = (config.host.as_str(), config.port)
        .to_socket_addrs()?
        .collect::<Vec<SocketAddr>>();
    if addresses.is_empty() {
        return Err(AppError::Runtime(format!(
            "no socket addresses resolved for {}:{}",
            config.host, config.port
        )));
    }

    let started_at = Instant::now();
    let mut last_error: Option<std::io::Error> = None;
    while started_at.elapsed() < SSH_CONNECT_TOTAL_TIMEOUT {
        check_shell_connection_cancelled(cancellation)?;

        for address in &addresses {
            check_shell_connection_cancelled(cancellation)?;
            let remaining = SSH_CONNECT_TOTAL_TIMEOUT.saturating_sub(started_at.elapsed());
            if remaining.is_zero() {
                break;
            }
            let timeout = remaining.min(SSH_CONNECT_SLICE_TIMEOUT);
            match TcpStream::connect_timeout(address, timeout) {
                Ok(stream) => return Ok(stream),
                Err(err) if is_retryable_connect_error(&err) => {
                    last_error = Some(err);
                }
                Err(err) => return Err(AppError::Io(err)),
            }
        }

        thread::sleep(SSH_CONNECT_POLL_INTERVAL);
    }

    Err(AppError::Io(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "connection attempt timed out for {}:{}",
                config.host, config.port
            ),
        )
    })))
}

fn check_shell_connection_cancelled(cancellation: Option<(&AppState, &str)>) -> AppResult<()> {
    if is_shell_connection_cancelled(cancellation) {
        return Err(AppError::Runtime(
            SSH_CONNECTION_CANCELLED_MESSAGE.to_string(),
        ));
    }
    Ok(())
}

fn is_shell_connection_cancelled(cancellation: Option<(&AppState, &str)>) -> bool {
    cancellation
        .map(|(state, request_id)| state.is_shell_connection_cancelled(request_id))
        .unwrap_or(false)
}

fn is_retryable_connect_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::Interrupted
    )
}

fn map_handshake_error(config: &SshConfig, err: ssh2::Error) -> AppError {
    let endpoint = format!("{}@{}:{}", config.username, config.host, config.port);
    let detail = err.message().trim();
    let detail_suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(" (detail: {detail})")
    };

    match err.code() {
        // LIBSSH2_ERROR_KEX_FAILURE: the algorithm lists genuinely do not overlap.
        // Deterministic for a given client and server pair, so retrying cannot help.
        ErrorCode::Session(-5) => AppError::Runtime(format!(
            "SSH algorithm negotiation failed for {endpoint} (Session -5). Client and server share no compatible key exchange, cipher, host key or MAC algorithm. Check the server-side sshd algorithm settings or use a host with modern SSH settings.{detail_suffix}"
        )),
        // LIBSSH2_ERROR_KEY_EXCHANGE_FAILURE: a key exchange packet round trip failed.
        // In practice the connection was cut mid-handshake (sshd dropping connections
        // under MaxStartups pressure, network reset, firewall), not a mismatch.
        ErrorCode::Session(-8) => AppError::Runtime(format!(
            "SSH key exchange was interrupted for {endpoint} (Session -8). The server or network closed the connection during the handshake, for example sshd shedding load under MaxStartups. Retrying usually succeeds.{detail_suffix}"
        )),
        // LIBSSH2_ERROR_TIMEOUT: our own handshake deadline elapsed.
        ErrorCode::Session(-9) => AppError::Runtime(format!(
            "SSH handshake timed out after {}s for {endpoint} (Session -9). The server accepted the TCP connection but did not complete the SSH handshake in time.{detail_suffix}",
            SSH_HANDSHAKE_TIMEOUT.as_secs()
        )),
        // SOCKET_DISCONNECT / SOCKET_RECV / SOCKET_SEND / BANNER_RECV
        ErrorCode::Session(code @ (-13 | -43 | -7 | -2)) => AppError::Runtime(format!(
            "SSH connection to {endpoint} was closed during the handshake (Session {code}).{detail_suffix}"
        )),
        _ => AppError::Ssh(err),
    }
}

fn run_channel_command(session: &Session, command: &str) -> AppResult<(String, String, i32)> {
    let channel = open_exec_channel(session, command)?;
    collect_channel_output(channel)
}

/// Opens a session channel and sends the exec request. Nothing has run remotely if this
/// fails, which is what makes retrying it on a fresh connection safe.
fn open_exec_channel(session: &Session, command: &str) -> AppResult<ssh2::Channel> {
    let mut channel = session.channel_session()?;
    channel.exec(command)?;
    Ok(channel)
}

fn collect_channel_output(mut channel: ssh2::Channel) -> AppResult<(String, String, i32)> {
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

    #[test]
    /// The reported failure: a `cd` followed by a chain was taken for a plain
    /// directory change, and the chain's whole stdout became the session cwd.
    /// Every later command in that tab then died with "File name too long".
    #[test]
    fn parse_cd_target_rejects_a_cd_that_chains_another_command() {
        assert_eq!(
            parse_cd_target("cd /opt/spring-blog && echo hi > compose.yml && sed -i s/a/b/ x"),
            None
        );
        assert_eq!(parse_cd_target("cd /srv && docker compose down"), None);
        assert_eq!(parse_cd_target("cd /tmp; ls -la"), None);
        assert_eq!(parse_cd_target("cd /tmp || true"), None);
        assert_eq!(parse_cd_target("cd /tmp | tee out"), None);
        assert_eq!(parse_cd_target("cd /tmp &"), None);
        assert_eq!(parse_cd_target("cd /tmp > out"), None);
        assert_eq!(parse_cd_target("cd /tmp < in"), None);
        assert_eq!(parse_cd_target("cd /tmp\nrm -rf /"), None);
    }

    #[test]
    fn parse_cd_target_accepts_a_directory_change_on_its_own() {
        assert_eq!(parse_cd_target("cd"), Some(None));
        assert_eq!(parse_cd_target("  cd  "), Some(None));
        assert_eq!(parse_cd_target("cd "), Some(None));
        assert_eq!(
            parse_cd_target("cd /opt/spring-blog"),
            Some(Some("/opt/spring-blog".to_string()))
        );
        assert_eq!(parse_cd_target("cd .."), Some(Some("..".to_string())));
        assert_eq!(parse_cd_target("cd -"), Some(Some("-".to_string())));
        // Expansions only ever yield the directory name, so `pwd` stays the
        // only thing on stdout and the cwd can still be tracked.
        assert_eq!(parse_cd_target("cd ~"), Some(Some("~".to_string())));
        assert_eq!(
            parse_cd_target("cd ~/work"),
            Some(Some("~/work".to_string()))
        );
        assert_eq!(
            parse_cd_target("cd $HOME/logs"),
            Some(Some("$HOME/logs".to_string()))
        );
    }

    #[test]
    fn parse_cd_target_ignores_commands_that_merely_start_with_cd() {
        assert_eq!(parse_cd_target("cdk deploy"), None);
        assert_eq!(parse_cd_target("cd/tmp"), None);
        assert_eq!(parse_cd_target("echo cd /tmp"), None);
        assert_eq!(parse_cd_target("ls"), None);
        assert_eq!(parse_cd_target(""), None);
    }

    #[test]
    fn parse_pwd_output_accepts_only_one_absolute_path() {
        assert_eq!(
            parse_pwd_output("/opt/spring-blog\n"),
            Some("/opt/spring-blog".to_string())
        );
        assert_eq!(
            parse_pwd_output("  /srv/app  "),
            Some("/srv/app".to_string())
        );
        assert_eq!(parse_pwd_output("/"), Some("/".to_string()));

        // Command output rather than a path.
        assert_eq!(parse_pwd_output(""), None);
        assert_eq!(parse_pwd_output("   "), None);
        assert_eq!(parse_pwd_output("relative/path"), None);
        assert_eq!(
            parse_pwd_output("services:\n  web:\n    image: nginx\n/opt/spring-blog"),
            None
        );
        assert_eq!(
            parse_pwd_output(&format!("/{}", "a".repeat(MAX_REMOTE_CWD_LEN))),
            None
        );
    }

    /// `sanitize_cwd` reshapes anything into something path-like, which is how
    /// a wall of command output was accepted as a working directory.
    #[test]
    fn parse_pwd_output_rejects_what_sanitize_cwd_would_have_reshaped() {
        let compose_dump = "services:\n  web:\n    image: nginx:alpine\n";

        assert_eq!(
            sanitize_cwd(compose_dump),
            "/services:\n  web:\n    image: nginx:alpine"
        );
        assert_eq!(parse_pwd_output(compose_dump), None);
    }

    #[test]
    fn is_transient_ssh_error_only_accepts_eagain() {
        let eagain = ssh2::Error::new(ErrorCode::Session(-37), "would block");
        assert!(is_transient_ssh_error(&eagain));

        let socket_send = ssh2::Error::new(ErrorCode::Session(-7), "unable to send data on socket");
        assert!(!is_transient_ssh_error(&socket_send));
    }

    fn handshake_test_config() -> SshConfig {
        SshConfig {
            id: "config-1".to_string(),
            name: "Test host".to_string(),
            host: "example.invalid".to_string(),
            port: 22,
            username: "tester".to_string(),
            auth_type: SshAuthType::Password,
            password: String::new(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        }
    }

    /// -5 and -8 both surface as "unable to exchange encryption keys" from libssh2, so the
    /// numeric code is the only thing that separates a genuine algorithm mismatch from a
    /// connection cut mid-handshake. Users act on these very differently.
    #[test]
    fn map_handshake_error_separates_negotiation_from_interruption() {
        let config = handshake_test_config();

        let negotiation = map_handshake_error(
            &config,
            ssh2::Error::new(ErrorCode::Session(-5), "Unable to exchange encryption keys"),
        )
        .to_string();
        assert!(negotiation.contains("Session -5"), "{negotiation}");
        assert!(negotiation.contains("no compatible"), "{negotiation}");
        assert!(!negotiation.contains("Retrying"), "{negotiation}");

        let interrupted = map_handshake_error(
            &config,
            ssh2::Error::new(ErrorCode::Session(-8), "Unable to exchange encryption keys"),
        )
        .to_string();
        assert!(interrupted.contains("Session -8"), "{interrupted}");
        assert!(interrupted.contains("MaxStartups"), "{interrupted}");
        assert!(!interrupted.contains("no compatible"), "{interrupted}");

        let timed_out =
            map_handshake_error(&config, ssh2::Error::new(ErrorCode::Session(-9), "timeout"))
                .to_string();
        assert!(timed_out.contains("Session -9"), "{timed_out}");
        assert!(timed_out.contains("timed out"), "{timed_out}");

        // Every mapped variant must still name the endpoint the user configured.
        for message in [negotiation, interrupted, timed_out] {
            assert!(message.contains("tester@example.invalid:22"), "{message}");
        }
    }

    #[test]
    fn map_handshake_error_passes_through_unrelated_codes() {
        let config = handshake_test_config();
        let auth_failed = map_handshake_error(
            &config,
            ssh2::Error::new(ErrorCode::Session(-18), "authentication failed"),
        );
        assert!(matches!(auth_failed, AppError::Ssh(_)));
    }

    #[test]
    fn stale_connection_errors_cover_dead_transports_but_not_remote_failures() {
        for code in [-7, -13, -43, -45, -9, -30, -2, -3, -14, -12, -4] {
            let err = AppError::Ssh(ssh2::Error::new(ErrorCode::Session(code), "transport gone"));
            assert!(
                is_stale_connection_error(&err),
                "code {code} should be stale"
            );
        }

        // A file that is absent or an authentication failure says nothing about the socket.
        for code in [-18, -31, -16] {
            let err = AppError::Ssh(ssh2::Error::new(ErrorCode::Session(code), "remote failure"));
            assert!(
                !is_stale_connection_error(&err),
                "code {code} should not be stale"
            );
        }

        assert!(is_stale_connection_error(&AppError::Io(
            std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset")
        )));
        assert!(!is_stale_connection_error(&AppError::Validation(
            "bad input".to_string()
        )));
    }

    #[test]
    fn inspect_local_upload_source_returns_name_and_size_for_file() {
        let root = unique_temp_dir("local-upload-source");
        std::fs::create_dir_all(&root).expect("create temp dir");
        let file_path = root.join("hello.txt");
        std::fs::write(&file_path, b"hello world").expect("write temp file");

        let source = inspect_local_upload_source(&file_path).expect("inspect local file");

        assert_eq!(source.file_name, "hello.txt");
        assert_eq!(source.total_bytes, 11);
    }

    #[test]
    fn inspect_local_upload_source_rejects_directories() {
        let root = unique_temp_dir("local-upload-dir");
        std::fs::create_dir_all(&root).expect("create temp dir");

        let error = inspect_local_upload_source(&root).expect_err("directory should fail");

        assert!(error.to_string().contains("not a regular file"));
    }

    #[test]
    fn transfer_progress_throttle_skips_events_until_interval_elapsed() {
        let mut throttle = TransferProgressThrottle::new(Duration::from_millis(200));
        let started_at = Instant::now();

        assert!(throttle.should_emit(started_at, false));
        assert!(!throttle.should_emit(started_at + Duration::from_millis(199), false));
        assert!(throttle.should_emit(started_at + Duration::from_millis(200), false));
    }

    #[test]
    fn transfer_progress_throttle_allows_forced_final_event() {
        let mut throttle = TransferProgressThrottle::new(Duration::from_millis(200));
        let started_at = Instant::now();

        assert!(throttle.should_emit(started_at, false));
        assert!(throttle.should_emit(started_at + Duration::from_millis(1), true));
    }

    #[test]
    fn atomic_write_temp_path_stays_next_to_target_file() {
        let temp_path = atomic_write_temp_path_with_suffix("/var/www/app/config.toml", "abc123");

        assert_eq!(temp_path, "/var/www/app/.config.toml.eshell-tmp-abc123");
    }

    #[test]
    fn atomic_write_rename_flags_allow_replacing_existing_file() {
        assert!(atomic_write_rename_flags()
            .expect("atomic write rename flags")
            .contains(RenameFlags::OVERWRITE));
    }

    #[test]
    fn finish_atomic_write_falls_back_to_direct_target_write_when_rename_fails() {
        let mut renamed = false;
        let mut direct_written = false;
        let mut temp_unlinked = false;
        let mut events = Vec::<String>::new();

        finish_atomic_write_with_fallback(
            || {
                renamed = true;
                Err(AppError::Runtime("rename rejected".to_string()))
            },
            || {
                direct_written = true;
                Ok(())
            },
            || {
                temp_unlinked = true;
                Ok(())
            },
            |event, _detail| events.push(event.to_string()),
            "/root/learn_k8s/nginx-deployment.yaml",
            "/root/learn_k8s/.nginx-deployment.yaml.eshell-tmp-test",
        )
        .expect("fallback save should succeed");

        assert!(renamed);
        assert!(direct_written);
        assert!(temp_unlinked);
        assert_eq!(
            events,
            vec![
                "sftp.write_file.rename_failed",
                "sftp.write_file.direct_write_fallback_succeeded"
            ]
        );
    }

    #[test]
    fn renamed_remote_path_stays_in_original_parent_directory() {
        let renamed = renamed_remote_path("/var/www/app/config.toml", "settings.toml")
            .expect("build rename path");

        assert_eq!(renamed, "/var/www/app/settings.toml");
    }

    #[test]
    fn renamed_remote_path_rejects_root_and_nested_names() {
        assert!(renamed_remote_path("/", "root").is_err());
        assert!(renamed_remote_path("/var/www/app/config.toml", "../settings.toml").is_err());
        assert!(renamed_remote_path("/var/www/app/config.toml", "nested/settings.toml").is_err());
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("eshell-service-{name}-{nonce}"))
    }
}
