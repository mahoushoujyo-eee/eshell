//! Server status polling, one module per metric.
//!
//! Each metric is a [`MetricProbe`]: it declares the shell command to run and
//! knows how to fold that command's output into the snapshot being built.
//!
//! Keeping the two halves together is the point of the trait. The command
//! strings used to live in `fetch_server_status` while the parsing lived in a
//! single flat `status_parser`, so adding or fixing a metric meant editing two
//! files and nothing tied a command to the parser that understood its output.

pub(crate) mod cpu;
pub(crate) mod disk;
pub(crate) mod gpu;
pub(crate) mod network;
pub(crate) mod process;
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
pub(crate) trait MetricProbe: Send + Sync {
    /// Stable name, used when reporting which probe misbehaved, and as the
    /// section label when the poll's commands are batched (see
    /// [`batch_command`]).
    fn id(&self) -> &'static str;

    /// The shell command to run. Owned so a probe can build it from constants
    /// that must not drift out of sync with its parser.
    ///
    /// A command is embedded in the batched poll script, so it must be a
    /// self-contained fragment that neither reads stdin nor depends on the
    /// working directory, and it must not print [`SECTION_MARKER_PREFIX`].
    fn command(&self) -> Cow<'static, str>;

    /// Folds this probe's section of the poll output into the snapshot.
    fn apply(&self, output: &str, draft: &mut ServerStatusDraft);
}

/// Every probe that a normal status poll runs, in execution order.
///
/// This list is the only place a new metric has to be registered.
///
/// The process probe runs last because it is the only slow one: it watches the
/// host for half a second to measure CPU. Batching means the whole list is one
/// round trip either way, so the order no longer saves a failed poll any work —
/// it is kept because the panel reads the metrics in this order.
pub(crate) fn default_probes() -> Vec<Box<dyn MetricProbe>> {
    vec![
        Box::new(cpu::CpuMemoryProbe),
        Box::new(network::NetworkProbe),
        Box::new(disk::DiskProbe),
        Box::new(gpu::GpuProbe),
        Box::new(process::ProcessProbe),
    ]
}

/// Opens one probe's section of the batched poll output.
///
/// The marker is echoed by the remote shell and matched on its own line, so a
/// section that produced no output at all still leaves its marker behind: a
/// probe that printed nothing stays distinguishable from a probe that never
/// ran.
const SECTION_MARKER_PREFIX: &str = "@@ESHELL-PROBE:";

/// Joins every probe's command into the single script one poll executes.
///
/// One exec instead of one per probe. Each command costs a channel open and a
/// round trip, which on a slow link dominates the poll: five sequential
/// commands put the poll's floor above a one-second refresh interval, and a
/// poll that cannot finish inside its interval is what makes the panel look
/// frozen. The commands themselves are unchanged, so every parser still reads
/// exactly the bytes it was written for.
pub(crate) fn batch_command(probes: &[Box<dyn MetricProbe>]) -> String {
    let mut script = String::new();
    for probe in probes {
        script.push_str("echo '");
        script.push_str(SECTION_MARKER_PREFIX);
        script.push_str(probe.id());
        script.push_str("@@'\n");
        script.push_str(&probe.command());
        script.push('\n');
    }
    script
}

/// Splits the batched poll's stdout back into one chunk per probe.
///
/// Returns `(probe id, section output)` in the order the markers appeared.
/// Text before the first marker is dropped: it can only be shell noise (a
/// login banner, a stray diagnostic), and no probe owns it.
pub(crate) fn split_sections(output: &str) -> Vec<(&str, String)> {
    let mut sections: Vec<(&str, String)> = Vec::new();
    let mut current: Option<(&str, String)> = None;

    for line in output.lines() {
        if let Some(id) = parse_section_marker(line) {
            if let Some(finished) = current.take() {
                sections.push(finished);
            }
            current = Some((id, String::new()));
            continue;
        }
        if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some(finished) = current {
        sections.push(finished);
    }
    sections
}

fn parse_section_marker(line: &str) -> Option<&str> {
    line.trim()
        .strip_prefix(SECTION_MARKER_PREFIX)?
        .strip_suffix("@@")
}

/// Collects probe results while a poll is in flight.
///
/// Defaults stand in for a probe that produced nothing, which is what makes a
/// missing or unreadable metric a blank field rather than a failed poll.
#[derive(Debug, Default)]
pub(crate) struct ServerStatusDraft {
    pub cpu_percent: f64,
    pub memory: MemoryStatus,
    pub network_interfaces: Vec<NetworkInterfaceStatus>,
    pub top_processes: Vec<ProcessStatus>,
    pub disks: Vec<DiskStatus>,
    pub gpus: Vec<GpuStatus>,
}

impl ServerStatusDraft {
    /// Resolves the caller's interface preference and stamps the fetch time.
    pub(crate) fn into_status(self, preferred_interface: Option<String>) -> ServerStatus {
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
            // A command that printed the marker would cut its own section in
            // two and hand the tail to the next probe.
            assert!(
                !probe.command().contains(SECTION_MARKER_PREFIX),
                "{} would collide with the section marker",
                probe.id()
            );
        }
    }

    /// The batched script is one exec: every probe is present, in order, each
    /// behind its own marker.
    #[test]
    fn batch_command_marks_every_probe_in_order() {
        let probes = default_probes();
        let script = batch_command(&probes);

        let mut cursor = 0;
        for probe in &probes {
            let marker = format!("{SECTION_MARKER_PREFIX}{}@@", probe.id());
            let at = script[cursor..]
                .find(&marker)
                .unwrap_or_else(|| panic!("{} is missing from the batch", probe.id()));
            cursor += at + marker.len();
        }
    }

    /// A probe that printed nothing keeps its marker, so it stays
    /// distinguishable from one that never ran.
    #[test]
    fn split_sections_keeps_empty_sections() {
        let output = "@@ESHELL-PROBE:cpu_memory@@\nCPU: 1.0% usr\n@@ESHELL-PROBE:disk@@\n@@ESHELL-PROBE:gpu@@\n";
        let sections = split_sections(output);

        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].0, "cpu_memory");
        assert_eq!(sections[0].1, "CPU: 1.0% usr\n");
        assert_eq!(sections[1], ("disk", String::new()));
        assert_eq!(sections[2], ("gpu", String::new()));
    }

    /// Noise before the first marker belongs to no probe.
    #[test]
    fn split_sections_drops_leading_noise() {
        let output = "Last login: Thu Sep 18 09:00:00 2026\n@@ESHELL-PROBE:disk@@\ndf output\n";
        let sections = split_sections(output);

        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0], ("disk", "df output\n".to_string()));
    }

    /// A multi-line section survives intact, blank lines included: the parsers
    /// locate columns by header, so a dropped line is a dropped metric.
    #[test]
    fn split_sections_preserves_section_bodies() {
        let output = "@@ESHELL-PROBE:process@@\n\n    PID USER %CPU COMMAND\n\n    1 root 0.0 systemd\n@@ESHELL-PROBE:gpu@@\n";
        let sections = split_sections(output);

        assert_eq!(sections[0].1, "\n    PID USER %CPU COMMAND\n\n    1 root 0.0 systemd\n");
    }

    /// Output with no marker at all yields nothing rather than a bogus section.
    #[test]
    fn split_sections_without_markers_yields_nothing() {
        assert!(split_sections("").is_empty());
        assert!(split_sections("top: unrecognized option '-w'\n").is_empty());
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
