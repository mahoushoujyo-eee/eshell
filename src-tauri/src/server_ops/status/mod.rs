//! Server status polling, one module per metric.
//!
//! Each metric is a [`MetricProbe`]: it declares the shell command to run and
//! knows how to fold that command's output into the snapshot being built.
//!
//! Keeping the two halves together is the point of the trait. The command
//! strings used to live in `fetch_server_status` while the parsing lived in a
//! single flat `status_parser`, so adding or fixing a metric meant editing two
//! files and nothing tied a command to the parser that understood its output.

mod cpu;
mod disk;
mod gpu;
mod network;
mod process;
mod text;

use std::borrow::Cow;

use crate::models::{
    DiskStatus, GpuStatus, MemoryStatus, NetworkInterfaceStatus, ProcessStatus, ServerStatus,
};

/// One metric source on the remote host.
///
/// A probe never fails the poll: output it cannot make sense of leaves the
/// draft untouched, so one unavailable tool (no `nvidia-smi`, a `top` variant
/// that prints something unexpected) still yields every other metric.
pub trait MetricProbe {
    /// Stable name, used when reporting which probe misbehaved.
    fn id(&self) -> &'static str;

    /// The shell command to run. Owned so a probe can build it from constants
    /// that must not drift out of sync with its parser.
    fn command(&self) -> Cow<'static, str>;

    /// Folds one command's stdout into the snapshot.
    fn apply(&self, output: &str, draft: &mut ServerStatusDraft);
}

/// Every probe that a normal status poll runs, in execution order.
///
/// This list is the only place a new metric has to be registered.
pub fn default_probes() -> Vec<Box<dyn MetricProbe>> {
    vec![
        Box::new(cpu::CpuMemoryProbe),
        Box::new(network::NetworkProbe),
        Box::new(process::ProcessProbe),
        Box::new(disk::DiskProbe),
        Box::new(gpu::GpuProbe),
    ]
}

/// Collects probe results while a poll is in flight.
///
/// Defaults stand in for a probe that produced nothing, which is what makes a
/// missing or unreadable metric a blank field rather than a failed poll.
#[derive(Debug, Default)]
pub struct ServerStatusDraft {
    pub cpu_percent: f64,
    pub memory: MemoryStatus,
    pub network_interfaces: Vec<NetworkInterfaceStatus>,
    pub top_processes: Vec<ProcessStatus>,
    pub disks: Vec<DiskStatus>,
    pub gpus: Vec<GpuStatus>,
}

impl ServerStatusDraft {
    /// Resolves the caller's interface preference and stamps the fetch time.
    pub fn into_status(self, preferred_interface: Option<String>) -> ServerStatus {
        let selected_interface =
            network::pick_selected_interface(&self.network_interfaces, preferred_interface);
        let selected_interface_traffic = selected_interface.as_ref().and_then(|name| {
            self.network_interfaces
                .iter()
                .find(|item| &item.interface == name)
                .cloned()
        });

        ServerStatus {
            cpu_percent: self.cpu_percent,
            memory: self.memory,
            network_interfaces: self.network_interfaces,
            selected_interface,
            selected_interface_traffic,
            top_processes: self.top_processes,
            disks: self.disks,
            gpus: self.gpus,
            fetched_at: crate::models::now_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_probe_has_a_distinct_id_and_a_command() {
        let probes = default_probes();
        assert_eq!(probes.len(), 5);

        let mut ids: Vec<&str> = probes.iter().map(|probe| probe.id()).collect();
        ids.sort_unstable();
        let unique = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), unique, "probe ids must be unique");

        for probe in &probes {
            assert!(
                !probe.command().trim().is_empty(),
                "{} has no command",
                probe.id()
            );
        }
    }

    /// A host where every command returns nothing must still produce a
    /// snapshot, so one broken metric cannot blank the whole panel.
    #[test]
    fn probes_leave_the_draft_untouched_on_empty_output() {
        let mut draft = ServerStatusDraft::default();
        for probe in default_probes() {
            probe.apply("", &mut draft);
        }

        let status = draft.into_status(None);
        assert_eq!(status.cpu_percent, 0.0);
        assert_eq!(status.memory.total_mb, 0.0);
        assert!(status.network_interfaces.is_empty());
        assert!(status.top_processes.is_empty());
        assert!(status.disks.is_empty());
        assert!(status.gpus.is_empty());
        assert_eq!(status.selected_interface, None);
    }

    #[test]
    fn into_status_keeps_a_valid_interface_preference_and_falls_back_otherwise() {
        let draft = || ServerStatusDraft {
            network_interfaces: vec![
                NetworkInterfaceStatus {
                    interface: "eth0".to_string(),
                    rx_bytes: 1,
                    tx_bytes: 2,
                },
                NetworkInterfaceStatus {
                    interface: "wlan0".to_string(),
                    rx_bytes: 3,
                    tx_bytes: 4,
                },
            ],
            ..Default::default()
        };

        let chosen = draft().into_status(Some("wlan0".to_string()));
        assert_eq!(chosen.selected_interface.as_deref(), Some("wlan0"));
        assert_eq!(chosen.selected_interface_traffic.unwrap().rx_bytes, 3);

        // A preference for an interface that is gone falls back to the first.
        let stale = draft().into_status(Some("tun9".to_string()));
        assert_eq!(stale.selected_interface.as_deref(), Some("eth0"));
    }
}
