//! Server-monitor domain tests, grouped by source module. Each section
//! imports from the real module path; the business files carry no inline
//! test code.


// ---------------------------------------------------------------------------
// service (status cache, poll, tauri surface)
// ---------------------------------------------------------------------------

use std::sync::Arc;

use crate::common::time::now_rfc3339;
use crate::domain::monitor::consts::*;
use crate::domain::monitor::model::*;
use crate::domain::monitor::service::probes::cpu::parse_cpu_and_memory;
use crate::domain::monitor::service::probes::disk::parse_disks;
use crate::domain::monitor::service::probes::gpu::parse_gpus;
use crate::domain::monitor::service::probes::network::parse_network_interfaces;
use crate::domain::monitor::service::probes::process::parse_top_processes;
use crate::domain::monitor::service::*;
use crate::domain::monitor::service::probes::*;
use crate::state::AppState;

fn temp_state() -> Arc<AppState> {
    let root = std::env::temp_dir().join(format!(
        "eshell-status-plugin-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    Arc::new(AppState::new(root).expect("create test state"))
}

fn shell_session(id: &str) -> crate::domain::ssh::model::session_model::ShellSession {
    crate::domain::ssh::model::session_model::ShellSession {
        id: id.to_string(),
        config_id: "config-1".to_string(),
        config_name: "Test host".to_string(),
        current_dir: "/home/test".to_string(),
        last_output: String::new(),
        created_at: now_rfc3339(),
        updated_at: now_rfc3339(),
    }
}

fn sample_status() -> ServerStatus {
    ServerStatus {
        cpu_percent: 12.5,
        memory: Default::default(),
        network_interfaces: Vec::new(),
        selected_interface: None,
        selected_interface_traffic: None,
        top_processes: Vec::new(),
        disks: Vec::new(),
        gpus: Vec::new(),
        fetched_at: now_rfc3339(),
    }
}

/// A status result that raced with `remove_session` must not be cached
/// for a dead tab: the sessions read lock is held across the insert.
#[test]
fn cache_insert_is_ignored_after_the_tab_is_removed() {
    let state = temp_state();
    state.put_session(shell_session("session-1"));
    state
        .status_plugin()
        .state
        .put(&state, "session-1", sample_status());
    assert!(state.status_plugin().state.get("session-1").is_some());

    state.remove_session("session-1").expect("remove shell");
    state
        .status_plugin()
        .state
        .put(&state, "session-1", sample_status());
    assert!(
        state.status_plugin().state.get("session-1").is_none(),
        "a dead tab's cache must not be resurrected"
    );
}

/// Tab teardown drops the cache entry (same semantics as before, now
/// owned by the plugin).
#[test]
fn session_removal_drops_the_cached_status() {
    let state = temp_state();
    state.put_session(shell_session("session-1"));
    state
        .status_plugin()
        .state
        .put(&state, "session-1", sample_status());
    state.remove_session("session-1").expect("remove shell");
    assert!(state.status_plugin().state.get("session-1").is_none());
}

/// Deactivation clears the plugin's own state and leaves user SSH
/// sessions (and activation of other extensions) alone.
#[test]
fn deactivate_clears_only_the_status_cache() {
    let state = temp_state();
    state.put_session(shell_session("session-1"));
    state
        .status_plugin()
        .state
        .put(&state, "session-1", sample_status());
    assert_eq!(test_cache_len(&state), 1);

    state.status_plugin().state.deactivate();
    assert_eq!(test_cache_len(&state), 0);
    // The tab itself survives: disabling the monitor is not closing SSH.
    assert!(state.get_session("session-1").is_ok());
}


// ---------------------------------------------------------------------------
// probes/mod (batch command, section split)
// ---------------------------------------------------------------------------

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


// ---------------------------------------------------------------------------
// probes/cpu
// ---------------------------------------------------------------------------

use super::*;

#[test]
fn parse_cpu_and_memory_works() {
    let top = r#"
top - 15:30:10 up 1 day,  1 user
%Cpu(s):  3.0 us,  1.0 sy,  0.0 ni, 96.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :  8000.0 total,  1200.0 free,  3500.0 used,  3300.0 buff/cache
"#;
    let parsed = parse_cpu_and_memory(top).expect("parse");
    assert_eq!(parsed.0, 4.0);
    assert_eq!(parsed.1.total_mb, 8000.0);
    assert_eq!(parsed.1.used_percent, 43.75);
}

#[test]
fn parse_cpu_and_memory_busybox_works() {
    let top = r#"
Mem: 15935K used, 1000K free, 0K shrd, 0K buff, 0K cached
CPU: 1.0% usr 2.0% sys 0.0% nic 96.0% idle 0.0% io 0.0% irq 0.0% sirq
"#;
    let parsed = parse_cpu_and_memory(top).expect("parse busybox");
    assert_eq!(parsed.0, 4.0);
    assert_eq!(parsed.1.used_mb, 15.56);
    assert_eq!(parsed.1.total_mb, 16.54);
    assert_eq!(parsed.1.used_percent, 94.1);
}

#[test]
fn parse_cpu_and_memory_kib_top_works() {
    let top = r#"
top - 08:58:09 up 10 min,  1 user
%Cpu(s):  0.4 us,  0.2 sy,  0.0 ni, 99.4 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
KiB Mem : 2061548 total, 1219396 free,   68676 used,  773476 buff/cache
"#;
    let parsed = parse_cpu_and_memory(top).expect("parse kib top");
    assert_eq!(parsed.0, 0.6);
    assert_eq!(parsed.1.used_mb, 67.07);
    assert_eq!(parsed.1.total_mb, 2013.23);
    assert_eq!(parsed.1.used_percent, 3.33);
}


// ---------------------------------------------------------------------------
// probes/disk
// ---------------------------------------------------------------------------

use super::*;

#[test]
fn parse_disks_works() {
    let raw = r#"
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   25G   70G  27% /
tmpfs           1.9G  2.0M  1.9G   1% /run
"#;
    let rows = parse_disks(raw);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].filesystem, "/dev/sda1");
    assert_eq!(rows[0].used_percent, "27%");
}


// ---------------------------------------------------------------------------
// probes/gpu
// ---------------------------------------------------------------------------

use super::*;

#[test]
fn parse_gpus_reads_metrics_and_attributes_processes_by_uuid() {
    let raw = format!(
        "0, GPU-1111, NVIDIA A100-SXM4-40GB, 37, 1234, 40960, 52, 78.12, 300.00, 41\n\
         1, GPU-2222, NVIDIA A100-SXM4-40GB, 0, 3, 40960, 31, 41.05, 300.00, 39\n\
         {separator}\n\
         GPU-2222, 4242, 1024, python3\n\
         GPU-1111, 777, 512, /usr/bin/ollama\n",
        separator = GPU_SECTION_SEPARATOR
    );

    let gpus = parse_gpus(&raw);
    assert_eq!(gpus.len(), 2);

    assert_eq!(gpus[0].index, 0);
    assert_eq!(gpus[0].name, "NVIDIA A100-SXM4-40GB");
    assert_eq!(gpus[0].utilization_percent, Some(37.0));
    assert_eq!(gpus[0].memory_used_mb, Some(1234.0));
    assert_eq!(gpus[0].memory_total_mb, Some(40960.0));
    assert_eq!(gpus[0].temperature_c, Some(52.0));
    assert_eq!(gpus[0].power_draw_w, Some(78.12));
    assert_eq!(gpus[0].power_limit_w, Some(300.0));
    assert_eq!(gpus[0].fan_percent, Some(41.0));

    // Each process lands on the card its uuid names, not on the first card.
    assert_eq!(gpus[0].processes.len(), 1);
    assert_eq!(gpus[0].processes[0].pid, 777);
    assert_eq!(gpus[0].processes[0].command, "/usr/bin/ollama");
    assert_eq!(gpus[0].processes[0].memory_mb, Some(512.0));

    assert_eq!(gpus[1].processes.len(), 1);
    assert_eq!(gpus[1].processes[0].pid, 4242);
    assert_eq!(gpus[1].processes[0].command, "python3");
}

/// Datacenter and virtualised cards report `[N/A]` or `[Not Supported]` for
/// whatever they do not expose, most often power limit and fan speed.
#[test]
fn parse_gpus_treats_unreported_metrics_as_missing() {
    let raw =
        "0, GPU-1111, Tesla T4, 12, 500, 15360, 44, [N/A], [Not Supported], [Unknown Error]";

    let gpus = parse_gpus(raw);
    assert_eq!(gpus.len(), 1);
    assert_eq!(gpus[0].utilization_percent, Some(12.0));
    assert_eq!(gpus[0].temperature_c, Some(44.0));
    assert_eq!(gpus[0].power_draw_w, None);
    assert_eq!(gpus[0].power_limit_w, None);
    assert_eq!(gpus[0].fan_percent, None);
    assert!(gpus[0].processes.is_empty());
}

/// A host with no NVIDIA driver produces no output at all, because the
/// status command only runs `nvidia-smi` when it is installed.
#[test]
fn parse_gpus_returns_nothing_for_a_host_without_a_gpu() {
    assert!(parse_gpus("").is_empty());
    assert!(parse_gpus("\n  \n").is_empty());
    assert!(parse_gpus(GPU_SECTION_SEPARATOR).is_empty());
    // A driver/library mismatch prints an error rather than CSV.
    assert!(parse_gpus("NVIDIA-SMI has failed because it couldn't communicate").is_empty());
}

/// Captured from a real `nvidia-smi` (RTX 3050, driver on Windows): per
/// process memory comes back as `[N/A]`, and processes the caller may not
/// inspect are named `[Insufficient Permissions]`. Both are reported as-is
/// rather than dropped, so the row still accounts for the pid.
#[test]
fn parse_gpus_handles_real_nvidia_smi_output() {
    let raw = format!(
        "0, GPU-9d32cee8-9537-2522-d0ab-7d8e1f15ae5a, NVIDIA GeForce RTX 3050, 46, 3332, 8192, 45, 13.22, 130.00, 0\n\
         {separator}\n\
         GPU-9d32cee8-9537-2522-d0ab-7d8e1f15ae5a, 1884, [N/A], [Insufficient Permissions]\n\
         GPU-9d32cee8-9537-2522-d0ab-7d8e1f15ae5a, 4564, [N/A], C:\\Windows\\explorer.exe\n",
        separator = GPU_SECTION_SEPARATOR
    );

    let gpus = parse_gpus(&raw);
    assert_eq!(gpus.len(), 1);
    assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 3050");
    assert_eq!(gpus[0].utilization_percent, Some(46.0));
    assert_eq!(gpus[0].memory_used_mb, Some(3332.0));
    assert_eq!(gpus[0].memory_total_mb, Some(8192.0));
    assert_eq!(gpus[0].power_draw_w, Some(13.22));
    assert_eq!(gpus[0].power_limit_w, Some(130.0));
    // A reported zero is a value, not a missing metric.
    assert_eq!(gpus[0].fan_percent, Some(0.0));

    assert_eq!(gpus[0].processes.len(), 2);
    assert_eq!(gpus[0].processes[0].pid, 1884);
    assert_eq!(gpus[0].processes[0].memory_mb, None);
    assert_eq!(gpus[0].processes[0].command, "[Insufficient Permissions]");
    assert_eq!(gpus[0].processes[1].command, "C:\\Windows\\explorer.exe");
}

#[test]
fn parse_gpus_keeps_commas_inside_a_process_name() {
    let raw = format!(
        "0, GPU-1111, Tesla T4, 5, 100, 15360, 40, 20.0, 70.0, 30\n\
         {separator}\n\
         GPU-1111, 99, 256, /opt/app --flag=a,b,c\n",
        separator = GPU_SECTION_SEPARATOR
    );

    let gpus = parse_gpus(&raw);
    assert_eq!(gpus[0].processes[0].command, "/opt/app --flag=a,b,c");
}

/// Older drivers omit the uuid column for compute apps. With a single card
/// the attribution is still unambiguous.
#[test]
fn parse_gpus_attributes_uuidless_processes_to_a_lone_card() {
    let raw = format!(
        "0, GPU-1111, Tesla T4, 5, 100, 15360, 40, 20.0, 70.0, 30\n\
         {separator}\n\
         , 99, 256, python3\n",
        separator = GPU_SECTION_SEPARATOR
    );

    let gpus = parse_gpus(&raw);
    assert_eq!(gpus[0].processes.len(), 1);
    assert_eq!(gpus[0].processes[0].pid, 99);
}

/// With several cards an unattributable process is dropped rather than
/// charged to an arbitrary one.
#[test]
fn parse_gpus_drops_uuidless_processes_when_several_cards_exist() {
    let raw = format!(
        "0, GPU-1111, Tesla T4, 5, 100, 15360, 40, 20.0, 70.0, 30\n\
         1, GPU-2222, Tesla T4, 5, 100, 15360, 40, 20.0, 70.0, 30\n\
         {separator}\n\
         , 99, 256, python3\n",
        separator = GPU_SECTION_SEPARATOR
    );

    let gpus = parse_gpus(&raw);
    assert_eq!(gpus.len(), 2);
    assert!(gpus.iter().all(|gpu| gpu.processes.is_empty()));
}


// ---------------------------------------------------------------------------
// probes/network
// ---------------------------------------------------------------------------

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


// ---------------------------------------------------------------------------
// probes/process
// ---------------------------------------------------------------------------

use super::*;

/// Two procps frames, the shape the probe actually asks for.
const PROCPS_TWO_FRAMES: &str = r#"
top - 09:12:33 up 3 days,  2:14,  1 user,  load average: 0.15, 0.09, 0.03
Tasks: 112 total,   1 running, 111 sleeping,   0 stopped,   0 zombie
%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni,100.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :   7937.4 total,   4312.1 free,   1201.3 used,   2424.0 buff/cache

PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
   1234 root      20   0 2461234   1.2g  18000 S   0.0  15.5   2:31.09 java
777 www-data  20   0  148820  25600   6400 S   0.0   0.3   0:44.10 nginx

PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
   8899 root      20   0    9876   3456   2048 R  99.9   0.0   0:00.51 top
   1234 root      20   0 2461234   1.2g  18000 S  42.7  15.5   2:31.11 java
777 www-data  20   0  148820  25600   6400 S   7.3   0.3   0:44.10 nginx
  1 root      20   0  168404  13012   8404 S   0.0   0.2   0:02.31 systemd
"#;

/// busybox, with its own column order, `%` suffixes and full command lines.
const BUSYBOX_FRAME: &str = r#"
Mem: 913392K used, 295116K free, 0K shrd, 0K buff, 0K cached
CPU:  1.9% usr  3.8% sys  0.0% nic 94.2% idle  0.0% io  0.0% irq  0.0% sirq
Load average: 0.15 0.09 0.03 2/112 8899
  PID  PPID USER     STAT   VSZ %VSZ %CPU COMMAND
 8899  8898 root     R     1220   0%  12% top -b -n2 -d1
  412     1 root     S     8512   1%   4% /usr/sbin/sshd -D -e
1     0 root     S     1656   0%   3% /bin/sh /run.sh --serve
"#;

#[test]
fn reads_the_second_frame_not_the_first() {
    let rows = parse_top_processes(PROCPS_TWO_FRAMES);
    assert_eq!(rows.len(), 3);
    // The first frame reports java at 0.0 (its since-boot average); the
    // value the panel needs is the 42.7 from the second one.
    assert_eq!(rows[0].command, "java");
    assert_eq!(rows[0].cpu_percent, 42.7);
    assert_eq!(rows[1].command, "nginx");
    assert_eq!(rows[1].cpu_percent, 7.3);
    assert_eq!(rows[2].command, "systemd");
}

#[test]
fn drops_the_sampler_rows() {
    let rows = parse_top_processes(PROCPS_TWO_FRAMES);
    assert!(
        rows.iter().all(|row| row.command != "top"),
        "the `top` we started must not be reported as the busiest process"
    );

    let rows = parse_top_processes(BUSYBOX_FRAME);
    assert!(rows.iter().all(|row| !row.command.starts_with("top ")));
}

#[test]
fn scales_memory_by_unit_suffix() {
    let rows = parse_top_processes(PROCPS_TWO_FRAMES);
    // procps abbreviates a resident size that no longer fits the column.
    assert_eq!(rows[0].memory_mb, 1228.8);
    assert_eq!(rows[1].memory_mb, 25.0);
}

#[test]
fn parses_the_busybox_layout() {
    let rows = parse_top_processes(BUSYBOX_FRAME);
    assert_eq!(rows.len(), 2);

    assert_eq!(rows[0].pid, 412);
    assert_eq!(rows[0].cpu_percent, 4.0);
    // VSZ, since busybox reports no resident size.
    assert_eq!(rows[0].memory_mb, 8.31);
    assert_eq!(rows[0].command, "/usr/sbin/sshd -D -e");

    // The whole command line survives, spaces included.
    assert_eq!(rows[1].command, "/bin/sh /run.sh --serve");
}

/// busybox built for SMP inserts a bare `CPU` column holding the core
/// number, right before `%CPU`.
#[test]
fn does_not_mistake_the_busybox_core_number_for_cpu_usage() {
    let raw = r#"
  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND
  412     1 root     S     8512   1%   3   4% /usr/sbin/sshd -D -e
"#;
    let rows = parse_top_processes(raw);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].cpu_percent, 4.0);
    assert_eq!(rows[0].memory_mb, 8.31);
}

/// The parser is header-driven, so the old `ps` listing still reads
/// correctly on a host where `top` is missing something.
#[test]
fn still_parses_a_ps_listing() {
    let raw = r#"
PID %CPU RSS COMMAND
123 12.5 41984 java
234 5.0 2048 nginx
"#;
    let rows = parse_top_processes(raw);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].pid, 123);
    assert_eq!(rows[0].cpu_percent, 12.5);
    assert_eq!(rows[0].memory_mb, 41.0);
    assert_eq!(rows[1].memory_mb, 2.0);
}

#[test]
fn keeps_the_busiest_five_rows() {
    let mut raw = String::from("PID %CPU RSS COMMAND\n");
    for index in 1..=20 {
        raw.push_str(&format!("{index} {index}.0 1024 worker{index}\n"));
    }

    let rows = parse_top_processes(&raw);
    assert_eq!(rows.len(), MAX_ROWS);
    assert_eq!(rows[0].cpu_percent, 20.0);
    assert_eq!(rows[4].cpu_percent, 16.0);
}

#[test]
fn output_without_a_usable_header_yields_nothing() {
    assert!(parse_top_processes("").is_empty());
    assert!(parse_top_processes("top: unrecognized option '-w'").is_empty());
    // A header we cannot map is as good as no header.
    assert!(parse_top_processes("PID USER COMMAND\n1 root systemd").is_empty());
}
