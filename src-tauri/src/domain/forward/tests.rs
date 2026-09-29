//! Registry-level tests for the port-forward plugin.
//!
//! The accept loop needs a live SSH transport, so it is covered by the
//! integration suite; what is testable in isolation is the registry contract —
//! filtering, ordering, status transitions and the guarantee that a closed tab
//! takes its forwards with it.

use super::model::{ForwardStatus, PortForward, TunnelStats};
use super::service::ForwardPlugin;

fn row(id: &str, session_id: &str, created_at: i64) -> PortForward {
    PortForward {
        id: id.to_string(),
        session_id: session_id.to_string(),
        bind_host: "127.0.0.1".to_string(),
        bind_port: 15432,
        target_host: "localhost".to_string(),
        target_port: 5432,
        status: ForwardStatus::Active,
        error: None,
        active_connections: 0,
        bytes_up: 0,
        bytes_down: 0,
        created_at,
    }
}

#[test]
fn list_returns_every_forward_in_creation_order() {
    let plugin = ForwardPlugin::new();
    plugin.insert(row("b", "tab-1", 2));
    plugin.insert(row("a", "tab-1", 1));

    let ids: Vec<String> = plugin.list(None).into_iter().map(|r| r.id).collect();
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn list_narrows_to_one_tab() {
    let plugin = ForwardPlugin::new();
    plugin.insert(row("a", "tab-1", 1));
    plugin.insert(row("b", "tab-2", 2));

    let ids: Vec<String> = plugin
        .list(Some("tab-2"))
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec!["b"]);
}

#[test]
fn tunnel_stats_accumulate_across_tunnels() {
    let plugin = ForwardPlugin::new();
    plugin.insert(row("a", "tab-1", 1));

    plugin.accumulate_stats(
        "a",
        TunnelStats {
            bytes_up: 10,
            bytes_down: 20,
        },
    );
    plugin.accumulate_stats(
        "a",
        TunnelStats {
            bytes_up: 5,
            bytes_down: 7,
        },
    );

    let stored = plugin.get("a").expect("row survives its tunnels");
    assert_eq!(stored.bytes_up, 15);
    assert_eq!(stored.bytes_down, 27);
    // One tunnel ending must not stop the forward.
    assert_eq!(stored.status, ForwardStatus::Active);
}

#[test]
fn a_forward_that_ends_records_why() {
    let plugin = ForwardPlugin::new();
    plugin.insert(row("a", "tab-1", 1));

    plugin.mark_ended("a", "SSH connection closed".to_string());

    let stored = plugin.get("a").expect("a failed forward stays listed");
    assert_eq!(stored.status, ForwardStatus::Failed);
    assert_eq!(stored.error.as_deref(), Some("SSH connection closed"));
}

#[test]
fn stopping_a_tab_forgets_only_that_tabs_forwards() {
    let plugin = ForwardPlugin::new();
    plugin.insert(row("a", "tab-1", 1));
    plugin.insert(row("b", "tab-2", 2));

    plugin.stop_session("tab-1");

    assert!(plugin.get("a").is_none());
    assert!(plugin.get("b").is_some());
}

#[test]
fn stopping_an_unknown_forward_is_a_no_op() {
    let plugin = ForwardPlugin::new();
    plugin.insert(row("a", "tab-1", 1));

    // No runtime was attached, so there is nothing to cancel — but the call
    // must not panic and must not touch the row.
    assert!(!plugin.stop("missing"));
    assert_eq!(
        plugin.get("a").map(|r| r.status),
        Some(ForwardStatus::Active)
    );
}
