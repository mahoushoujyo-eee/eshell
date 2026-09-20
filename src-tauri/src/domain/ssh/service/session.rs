use std::sync::Arc;
use std::time::Instant;

use russh::ChannelMsg;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::channel::OwnedChannel;
use super::pty;
use super::transport::{self, is_stale_connection_error};
use crate::common::error::{AppError, AppResult};
use crate::common::logging::append_server_ops_debug_log;
use crate::common::time::now_rfc3339;
use crate::domain::sftp::service::normalize_remote_path;
use crate::domain::ssh::consts::*;
use crate::domain::ssh::model::session_model::CommandExecutionResult;
use crate::domain::ssh::model::session_model::ShellSession;
use crate::state::{AppState, PtyCommand, SharedSshSession};

/// Establishes one transport for the tab, then opens its interactive channel.
pub async fn open_shell_session(
    state: Arc<AppState>,
    app: AppHandle,
    config_id: &str,
    request_id: Option<&str>,
) -> AppResult<ShellSession> {
    let cancel = request_id
        .map(|id| state.begin_shell_connection(id))
        .unwrap_or_default();
    let _request = ShellConnectionGuard {
        state: &state,
        request_id,
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(AppError::Runtime(SSH_CONNECTION_CANCELLED_MESSAGE.to_string())),
        result = open_shell_session_inner(&state, app, config_id, &cancel) => result,
    }
}

struct ShellConnectionGuard<'a> {
    state: &'a AppState,
    request_id: Option<&'a str>,
}

impl Drop for ShellConnectionGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.request_id {
            self.state.clear_shell_connection(id);
        }
    }
}

async fn open_shell_session_inner(
    state: &Arc<AppState>,
    app: AppHandle,
    config_id: &str,
    cancel: &CancellationToken,
) -> AppResult<ShellSession> {
    let config = state.storage.find_ssh_config(config_id)?;
    let ssh = Arc::new(transport::connect(state, Some(&app), &config, cancel.clone()).await?);
    let channel = pty::open_channel(&ssh).await?;
    let now = now_rfc3339();
    let session = ShellSession {
        id: Uuid::new_v4().to_string(),
        config_id: config.id,
        config_name: config.name,
        // Unknown until an explicit cd. Exec starts in the login home directory;
        // the frontend's existing SFTP fallback is currentDir || "/".
        current_dir: String::new(),
        last_output: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    if cancel.is_cancelled() {
        return Err(AppError::Runtime(
            SSH_CONNECTION_CANCELLED_MESSAGE.to_string(),
        ));
    }
    state.put_session(session.clone());
    if let Err(error) = state.put_ssh_session(&session.id, Arc::clone(&ssh)) {
        let _ = state.remove_session(&session.id);
        return Err(error);
    }
    pty::start_worker(Arc::clone(state), app, session.id.clone(), ssh, channel);
    Ok(session)
}

/// Reopens the interactive PTY channel of an existing tab.
///
/// A tab outlives its PTY worker: the worker exits on EOF, a read failure or a
/// dropped transport, and `pty.rs` deliberately keeps the session record so the
/// tab can be recovered without losing its identity, working directory and
/// status cache. This rebuilds the channel against that same record — and the
/// tab's SSH connection, which `cached_ssh_session` re-establishes on demand —
/// rather than opening a second session, so a recovery never leaves an orphan
/// tab behind for `list_shell_sessions` to resurrect.
pub async fn reopen_shell_pty(
    state: Arc<AppState>,
    app: AppHandle,
    session_id: &str,
) -> AppResult<ShellSession> {
    state.get_session(session_id)?;
    let (ssh, channel) = open_pty_channel(&state, Some(&app), session_id).await?;
    // Re-check after the handshake: the tab may have been closed while we waited,
    // and `put_pty_channel` would then reject the worker and leak the channel.
    let session = state.get_session(session_id)?;
    pty::start_worker(Arc::clone(&state), app, session.id.clone(), ssh, channel);
    Ok(session)
}

/// Opens a PTY channel on the tab's transport, rebuilding a dead one once.
///
/// Mirrors `run_session_command`: the whole reason a reopen is being asked for
/// is that the previous transport failed, so a cached connection that is closed
/// or that refuses the channel is evicted and replaced before giving up.
async fn open_pty_channel(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
) -> AppResult<(SharedSshSession, pty::PtyChannel)> {
    for attempt in 1..=2 {
        let shared = cached_ssh_session(state, app, session_id).await?;
        match pty::open_channel(&shared).await {
            Ok(channel) => return Ok((shared, channel)),
            Err(err) => {
                if !is_stale_connection_error(&err) && !shared.is_closed() {
                    return Err(err);
                }
                let evicted = state.evict_ssh_session(session_id, &shared);
                append_server_ops_debug_log(
                    state,
                    "ssh.pty_reopen.stale",
                    session_id,
                    format!("attempt={attempt} evicted={evicted} error={err}"),
                );
                if attempt == 2 {
                    return Err(err);
                }
            }
        }
    }
    unreachable!("both PTY channel attempts return or execute")
}

/// Closes and removes a shell session from runtime registry.
pub fn close_shell_session(state: &AppState, session_id: &str) -> AppResult<()> {
    match state.remove_session(session_id) {
        Ok(()) | Err(AppError::NotFound(_)) => Ok(()),
        Err(err) => Err(err),
    }
}

pub fn pty_write_input(state: &AppState, session_id: &str, data: &str) -> AppResult<()> {
    if data.is_empty() {
        return Ok(());
    }
    state.send_pty_command(session_id, PtyCommand::Input(data.to_string()))
}

pub fn pty_resize(state: &AppState, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
    state.send_pty_command(
        session_id,
        PtyCommand::Resize {
            cols: cols.max(20),
            rows: rows.max(8),
        },
    )
}

/// Executes a command on its own channel without locking the tab's transport.
pub async fn execute_command(
    state: &Arc<AppState>,
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
    let cd_target = parse_cd_target(trimmed);
    let remote_command = match &cd_target {
        Some(target) => command_in_directory(
            &session.current_dir,
            &format!("cd {} && pwd", target.as_deref().unwrap_or("~")),
        ),
        None => command_in_directory(&session.current_dir, command),
    };
    let (stdout, stderr, exit_code) =
        run_session_command(state, None, session_id, &remote_command).await?;

    if cd_target.is_some() {
        if exit_code == 0 {
            let new_dir = parse_pwd_output(&stdout);
            if new_dir.is_none() {
                append_server_ops_debug_log(
                    state,
                    "shell.cd.unexpected_pwd_output",
                    session_id,
                    format!("bytes={} command={trimmed}", stdout.trim().len()),
                );
            }
            state.mutate_session(session_id, |entry| {
                if let Some(new_dir) = new_dir {
                    entry.current_dir = new_dir;
                }
                entry.last_output = stdout.trim().to_string();
                entry.updated_at = now_rfc3339();
            })?;
        }
    } else {
        state.mutate_session(session_id, |entry| {
            entry.last_output = format_stdout_stderr(&stdout, &stderr);
            entry.updated_at = now_rfc3339();
        })?;
    }

    Ok(CommandExecutionResult {
        session_id: session_id.to_string(),
        command: command.to_string(),
        stdout,
        stderr,
        exit_code,
        current_dir: state.get_session(session_id)?.current_dir,
        started_at,
        finished_at: now_rfc3339(),
        duration_ms: started_clock.elapsed().as_millis(),
    })
}

pub(crate) fn command_in_directory(current_dir: &str, command: &str) -> String {
    match current_dir.trim() {
        "" | "~" => command.to_string(),
        _ => format!("cd {} && {command}", shell_quote(current_dir)),
    }
}

/// Runs one probe command on the tab's transport and returns its stdout.
///
/// This is the narrow bridge the server-monitor plugin uses: probe commands
/// are ordinary session commands, so they reuse the core's channel-open
/// retry boundary (never replaying an EXEC) instead of the plugin opening
/// its own channels.
pub async fn run_session_command_for_probe(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
    command: &str,
) -> AppResult<String> {
    Ok(run_session_command(state, app, session_id, command)
        .await?
        .0)
}

pub fn ssh_ki_respond(state: &AppState, request_id: &str, responses: Vec<String>) -> AppResult<()> {
    state.respond_ki(request_id, responses)
}

pub(crate) async fn cached_ssh_session(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
) -> AppResult<SharedSshSession> {
    let session = state.get_session(session_id)?;
    let config = state.storage.find_ssh_config(&session.config_id)?;
    let cancel = state.shell_session_token(session_id)?;
    state
        .get_or_insert_ssh_session(session_id, || {
            transport::connect(state, app, &config, cancel)
        })
        .await
}

/// The only retry boundary is opening the channel, before sending EXEC. Even a
/// rejected EXEC request is not replayed: the server may have already acted.
async fn run_session_command(
    state: &Arc<AppState>,
    app: Option<&AppHandle>,
    session_id: &str,
    command: &str,
) -> AppResult<(String, String, i32)> {
    let tab_cancel = state.shell_session_token(session_id)?;
    for attempt in 1..=2 {
        let shared = cached_ssh_session(state, app, session_id).await?;
        let channel = match shared.channel_open_session().await {
            Ok(channel) => channel,
            Err(err) => {
                if !is_stale_connection_error(&err) && !shared.is_closed() {
                    return Err(err);
                }
                let evicted = state.evict_ssh_session(session_id, &shared);
                append_server_ops_debug_log(
                    state,
                    "ssh.session_command.stale",
                    session_id,
                    format!("attempt={attempt} evicted={evicted} error={err}"),
                );
                if attempt == 2 {
                    return Err(err);
                }
                continue;
            }
        };
        let mut channel = OwnedChannel::new(channel);
        let link_cancel = shared.cancellation_token();
        let result = tokio::select! {
            biased;
            _ = tab_cancel.cancelled() => Err(AppError::Runtime("shell session closed".to_string())),
            _ = link_cancel.cancelled() => Err(AppError::SshTransport(russh::Error::Disconnect)),
            result = tokio::time::timeout(COMMAND_TIMEOUT, async {
                channel.write.exec(true, command.as_bytes().to_vec()).await?;
                // Non-interactive commands receive no stdin. Without EOF, a command
                // such as cat waits forever and occupies a server session slot.
                channel.write.eof().await?;
                collect_channel_output(&mut channel).await
            }) => result.unwrap_or_else(|_| Err(AppError::Runtime("SSH command timed out; it was not retried".to_string()))),
        };
        if result.as_ref().err().is_some_and(is_stale_connection_error) || shared.is_closed() {
            state.evict_ssh_session(session_id, &shared);
        }
        return result;
    }
    unreachable!("both channel-open attempts return or execute")
}

async fn collect_channel_output(channel: &mut OwnedChannel) -> AppResult<(String, String, i32)> {
    let mut output = CommandOutput::default();
    while let Some(message) = channel.read.wait().await {
        if output.apply(message)? {
            break;
        }
    }
    output.finish()
}

#[derive(Default)]
pub(crate) struct CommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
}

impl CommandOutput {
    pub(crate) fn apply(&mut self, message: ChannelMsg) -> AppResult<bool> {
        match message {
            ChannelMsg::Data { data } => {
                self.check_size(data.len())?;
                self.stdout.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                self.check_size(data.len())?;
                self.stderr.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => self.exit_code = Some(exit_status as i32),
            ChannelMsg::ExitSignal { .. } => self.exit_code = Some(128),
            ChannelMsg::Failure => {
                return Err(AppError::Runtime("SSH exec request rejected".to_string()))
            }
            ChannelMsg::Close => return Ok(true),
            // EOF closes the data stream, not the request; exit-status can follow it.
            _ => {}
        }
        Ok(false)
    }

    pub(crate) fn check_size(&self, additional: usize) -> AppResult<()> {
        if self.stdout.len() + self.stderr.len() + additional > MAX_COMMAND_OUTPUT_BYTES {
            return Err(AppError::Runtime(
                "SSH command output exceeds 64 MiB; it was not retried".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn finish(self) -> AppResult<(String, String, i32)> {
        let exit_code = self.exit_code.ok_or_else(|| {
            AppError::Runtime(
                "SSH command channel closed without an exit status; it was not retried".to_string(),
            )
        })?;
        Ok((
            String::from_utf8_lossy(&self.stdout).into_owned(),
            String::from_utf8_lossy(&self.stderr).into_owned(),
            exit_code,
        ))
    }
}


/// Only a standalone cd updates the tab's tracked working directory.
pub(crate) fn parse_cd_target(command: &str) -> Option<Option<String>> {
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

fn is_single_cd_target(target: &str) -> bool {
    !target
        .chars()
        .any(|ch| matches!(ch, '&' | '|' | ';' | '<' | '>') || ch.is_control())
}

/// Reject banners and command output rather than reshaping them into a path.
pub(crate) fn parse_pwd_output(output: &str) -> Option<String> {
    let trimmed = output.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_REMOTE_CWD_LEN
        || !trimmed.starts_with('/')
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    Some(sanitize_cwd(trimmed))
}

pub(crate) fn sanitize_cwd(value: &str) -> String {
    if value.trim().is_empty() {
        "/".to_string()
    } else {
        normalize_remote_path(value.trim())
    }
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
