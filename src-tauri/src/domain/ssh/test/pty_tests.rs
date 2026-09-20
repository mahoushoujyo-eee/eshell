//! Unit tests for `ssh/service/pty.rs`: the PTY output decoder.

use tokio::sync::mpsc;

use crate::domain::ssh::service::pty::*;
use crate::state::PtyCommand;

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
