//! Per-interface traffic counters from `/proc/net/dev`.

use std::borrow::Cow;

use crate::models::NetworkInterfaceStatus;

use super::{MetricProbe, ServerStatusDraft};

/// Parses `/proc/net/dev` output to per-interface RX/TX traffic.
pub fn parse_network_interfaces(output: &str) -> Vec<NetworkInterfaceStatus> {
    let mut rows = Vec::new();

    for line in output.lines().skip(2) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((iface, stats)) = trimmed.split_once(':') else {
            continue;
        };
        let cols: Vec<&str> = stats.split_whitespace().collect();
        if cols.len() < 16 {
            continue;
        }
        let Ok(rx_bytes) = cols[0].parse::<u64>() else {
            continue;
        };
        let Ok(tx_bytes) = cols[8].parse::<u64>() else {
            continue;
        };
        rows.push(NetworkInterfaceStatus {
            interface: iface.trim().to_string(),
            rx_bytes,
            tx_bytes,
        });
    }

    rows
}

pub(super) struct NetworkProbe;

impl MetricProbe for NetworkProbe {
    fn id(&self) -> &'static str {
        "network"
    }

    fn command(&self) -> Cow<'static, str> {
        Cow::Borrowed("cat /proc/net/dev")
    }

    fn apply(&self, output: &str, draft: &mut ServerStatusDraft) {
        draft.network_interfaces = parse_network_interfaces(output);
    }
}

/// Honours the caller's interface choice while it still exists, otherwise falls
/// back to the first interface the host reported.
pub(super) fn pick_selected_interface(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_network_interfaces_works() {
        let raw = r#"
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  lo: 205700  1024 0 0 0 0 0 0 205700  1024 0 0 0 0 0 0
eth0: 9876543 9999 0 0 0 0 0 0 1234567 8888 0 0 0 0 0 0
"#;
        let rows = parse_network_interfaces(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].interface, "eth0");
        assert_eq!(rows[1].tx_bytes, 1_234_567);
    }
}
