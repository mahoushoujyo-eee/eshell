//! Async PTY pumping. A blocked input window never stops output or tab closure.

use std::sync::Arc;
use std::time::Duration;

use russh::ChannelMsg;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use super::channel::OwnedChannel;
use super::service::append_server_ops_debug_log;
use crate::error::{AppError, AppResult};
use crate::models::{now_rfc3339, PtyClosedEvent, PtyOutputEvent};
use crate::state::{AppState, PtyCommand, SharedSshSession};

const DEFAULT_PTY_COLS: u32 = 120;
const DEFAULT_PTY_ROWS: u32 = 36;
const MAX_SESSION_LAST_OUTPUT_CHARS: usize = 16_000;
const PTY_MAX_COMMANDS_PER_TICK: usize = 64;
const PTY_OUTPUT_INTERVAL: Duration = Duration::from_millis(8);
const PTY_OUTPUT_BATCH_BYTES: usize = 128 * 1024;

pub(super) struct PtyChannel {
    channel: OwnedChannel,
    initial_output: Vec<u8>,
}

pub(super) async fn open_channel(ssh: &SharedSshSession) -> AppResult<PtyChannel> {
    let mut channel = OwnedChannel::new(ssh.channel_open_session().await?);
    let cancel = ssh.cancellation_token();
    let mut initial_output = Vec::new();
    tokio::select! {
        _ = cancel.cancelled() => return Err(AppError::SshTransport(russh::Error::Disconnect)),
        result = tokio::time::timeout(Duration::from_secs(30), async {
            channel.write.request_pty(true, "xterm-256color", DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, 0, 0, &[]).await?;
            wait_request_success(&mut channel, &mut initial_output).await?;
            channel.write.request_shell(true).await?;
            wait_request_success(&mut channel, &mut initial_output).await
        }) => result.map_err(|_| AppError::Runtime("SSH PTY setup timed out".to_string()))??,
    }
    Ok(PtyChannel {
        channel,
        initial_output,
    })
}

async fn wait_request_success(channel: &mut OwnedChannel, output: &mut Vec<u8>) -> AppResult<()> {
    loop {
        match channel.read.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                if output.len() + data.len() > PTY_OUTPUT_BATCH_BYTES {
                    return Err(AppError::Runtime(
                        "SSH PTY produced too much output before accepting the request".to_string(),
                    ));
                }
                output.extend_from_slice(&data);
            }
            Some(ChannelMsg::Failure) => {
                return Err(AppError::Runtime(
                    "SSH PTY/shell request rejected".to_string(),
                ))
            }
            Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(AppError::SshTransport(russh::Error::Disconnect))
            }
            _ => {}
        }
    }
}

pub(super) fn start_worker(
    state: Arc<AppState>,
    app: AppHandle,
    session_id: String,
    ssh: SharedSshSession,
    channel: PtyChannel,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    state.put_pty_channel(session_id.clone(), tx);
    append_server_ops_debug_log(
        &state,
        "pty.worker.started",
        &session_id,
        "keepalive_sec=20 cols=120 rows=36",
    );
    tauri::async_runtime::spawn(run_worker(state, app, session_id, ssh, channel, rx));
}

async fn run_worker(
    state: Arc<AppState>,
    app: AppHandle,
    session_id: String,
    ssh: SharedSshSession,
    pty: PtyChannel,
    mut rx: mpsc::UnboundedReceiver<PtyCommand>,
) {
    let Ok(tab_cancel) = state.shell_session_token(&session_id) else {
        return;
    };
    let link_cancel = ssh.cancellation_token();
    let PtyChannel {
        mut channel,
        initial_output,
    } = pty;
    let mut writer = channel.write.make_writer();
    let mut pending_input = Vec::new();
    let mut pending_offset = 0;
    let mut latest_resize = None;
    let mut output = Utf8Output {
        bytes: initial_output,
    };
    let mut ticker = tokio::time::interval(PTY_OUTPUT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let close_reason = loop {
        tokio::select! {
            _ = tab_cancel.cancelled() => break None,
            _ = link_cancel.cancelled() => break Some("connection_lost".to_string()),
            command = rx.recv() => {
                let Some(command) = command else { break None };
                let mut batch = PtyCommandBatch::default();
                batch.push(command);
                if !batch.close_requested {
                    let rest = drain_pty_command_batch(&mut rx, PTY_MAX_COMMANDS_PER_TICK - 1);
                    batch.input.extend(rest.input);
                    batch.latest_resize = rest.latest_resize.or(batch.latest_resize);
                    batch.close_requested = rest.close_requested;
                }
                if batch.close_requested { break None; }
                compact_pending_input(&mut pending_input, &mut pending_offset);
                pending_input.extend(batch.input);
                latest_resize = batch.latest_resize.or(latest_resize);
            }
            result = writer.write(&pending_input[pending_offset..]), if pending_offset < pending_input.len() => {
                match result {
                    Ok(0) => break Some("write_failed: channel closed".to_string()),
                    Ok(size) => {
                        pending_offset += size;
                        compact_pending_input(&mut pending_input, &mut pending_offset);
                    }
                    Err(error) => break Some(format!("write_failed: {error}")),
                }
            }
            result = async {
                let (cols, rows) = latest_resize.expect("resize branch enabled");
                channel.write.window_change(u32::from(cols), u32::from(rows), 0, 0).await
            }, if latest_resize.is_some() => {
                if let Err(error) = result { break Some(format!("write_failed: {error}")); }
                latest_resize = None;
            }
            message = channel.read.wait() => {
                match message {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                        output.bytes.extend_from_slice(&data);
                        if output.bytes.len() >= PTY_OUTPUT_BATCH_BYTES {
                            flush_output(&state, &app, &session_id, &mut output, false);
                        }
                    }
                    Some(ChannelMsg::Close) | None => break Some("eof".to_string()),
                    Some(ChannelMsg::Failure) => break Some("read_failed: shell request rejected".to_string()),
                    _ => {}
                }
            }
            _ = ticker.tick(), if !output.bytes.is_empty() => {
                flush_output(&state, &app, &session_id, &mut output, false);
            }
        }
    };
    flush_output(&state, &app, &session_id, &mut output, true);
    drop(writer);
    drop(channel);
    append_server_ops_debug_log(
        &state,
        "pty.worker.stopped",
        &session_id,
        "session_removed=true",
    );
    let close_reason = close_reason.filter(|_| !tab_cancel.is_cancelled());
    if ssh.is_closed() && !tab_cancel.is_cancelled() {
        // A concurrent exec may already be replacing this dead transport. Keep
        // the tab identity until explicit close/reconnect; never kill its replacement.
        state.remove_pty_channel(&session_id);
        state.evict_ssh_session(&session_id, &ssh);
    } else {
        let _ = state.remove_session(&session_id);
    }
    if let Some(reason) = close_reason {
        let _ = app.emit("pty-closed", PtyClosedEvent { session_id, reason });
    }
}

fn flush_output(
    state: &AppState,
    app: &AppHandle,
    session_id: &str,
    output: &mut Utf8Output,
    final_chunk: bool,
) {
    let chunk = output.take(final_chunk);
    if chunk.is_empty() {
        return;
    }
    let _ = state.mutate_session(session_id, |session| {
        session.last_output.push_str(&chunk);
        trim_to_last_chars(&mut session.last_output, MAX_SESSION_LAST_OUTPUT_CHARS);
        session.updated_at = now_rfc3339();
    });
    let _ = app.emit(
        "pty-output",
        PtyOutputEvent {
            session_id: session_id.to_string(),
            chunk,
        },
    );
}

/// SSH packet boundaries need not coincide with UTF-8 code point boundaries.
#[derive(Default)]
struct Utf8Output {
    bytes: Vec<u8>,
}

impl Utf8Output {
    fn take(&mut self, final_chunk: bool) -> String {
        let mut consumed = 0;
        let mut text = String::new();
        while consumed < self.bytes.len() {
            match std::str::from_utf8(&self.bytes[consumed..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    consumed = self.bytes.len();
                }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    text.push_str(
                        std::str::from_utf8(&self.bytes[consumed..end]).expect("valid prefix"),
                    );
                    consumed = end;
                    match error.error_len() {
                        Some(len) => {
                            text.push('\u{fffd}');
                            consumed += len;
                        }
                        None if final_chunk => {
                            text.push('\u{fffd}');
                            consumed = self.bytes.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.bytes.drain(..consumed);
        text
    }
}

fn trim_to_last_chars(value: &mut String, max_chars: usize) {
    let total = value.chars().count();
    if total > max_chars {
        let offset = value
            .char_indices()
            .nth(total - max_chars)
            .map(|(index, _)| index)
            .unwrap_or(value.len());
        value.drain(..offset);
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct PtyCommandBatch {
    input: Vec<u8>,
    latest_resize: Option<(u16, u16)>,
    close_requested: bool,
    drained_messages: usize,
}

impl PtyCommandBatch {
    fn push(&mut self, command: PtyCommand) {
        self.drained_messages += 1;
        match command {
            PtyCommand::Input(data) => self.input.extend_from_slice(data.as_bytes()),
            PtyCommand::Resize { cols, rows } => self.latest_resize = Some((cols, rows)),
            PtyCommand::Close => self.close_requested = true,
        }
    }
}

fn drain_pty_command_batch(
    rx: &mut mpsc::UnboundedReceiver<PtyCommand>,
    max_messages: usize,
) -> PtyCommandBatch {
    let mut batch = PtyCommandBatch::default();
    while batch.drained_messages < max_messages.max(1) {
        match rx.try_recv() {
            Ok(command) => {
                batch.push(command);
                if batch.close_requested {
                    break;
                }
            }
            Err(mpsc::error::TryRecvError::Empty) => break,
            Err(mpsc::error::TryRecvError::Disconnected) => {
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
    } else if *pending_offset >= 4096 && *pending_offset * 2 >= pending_input.len() {
        pending_input.drain(..*pending_offset);
        *pending_offset = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_pty_command_batch_respects_limit_and_keeps_order() {
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyCommand>();
        tx.send(PtyCommand::Input("aa".to_string()))
            .expect("send input");
        tx.send(PtyCommand::Resize {
            cols: 120,
            rows: 40,
        })
        .expect("send resize");
        tx.send(PtyCommand::Input("bb".to_string()))
            .expect("send input");
        let first = drain_pty_command_batch(&mut rx, 2);
        assert_eq!(first.drained_messages, 2);
        assert_eq!(first.input, b"aa");
        assert_eq!(first.latest_resize, Some((120, 40)));
        assert!(!first.close_requested);
        let second = drain_pty_command_batch(&mut rx, 2);
        assert_eq!(second.drained_messages, 1);
        assert_eq!(second.input, b"bb");
        assert_eq!(second.latest_resize, None);
        assert!(!second.close_requested);
    }

    #[test]
    fn drain_pty_command_batch_stops_on_close() {
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyCommand>();
        tx.send(PtyCommand::Input("before".to_string()))
            .expect("send input");
        tx.send(PtyCommand::Close).expect("send close");
        tx.send(PtyCommand::Input("after".to_string()))
            .expect("send input");
        let batch = drain_pty_command_batch(&mut rx, 10);
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
    fn output_preserves_unicode_split_between_packets() {
        let mut output = Utf8Output::default();
        output.bytes.extend_from_slice(&[b'a', 0xe4, 0xb8]);
        assert_eq!(output.take(false), "a");
        output.bytes.extend_from_slice(&[0xad, b'b']);
        assert_eq!(output.take(false), "中b");
        assert!(output.bytes.is_empty());
    }

    #[test]
    fn output_replaces_invalid_and_final_incomplete_sequences() {
        let mut output = Utf8Output {
            bytes: vec![0xff, b'a', 0xe4],
        };
        assert_eq!(output.take(false), "�a");
        assert_eq!(output.take(true), "�");
    }
}
