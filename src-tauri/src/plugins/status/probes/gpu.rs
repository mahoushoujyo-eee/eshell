//! NVIDIA GPU metrics and compute processes, from `nvidia-smi`.

use std::borrow::Cow;

use crate::models::{GpuProcessStatus, GpuStatus};

use super::text::round2;
use super::{MetricProbe, ServerStatusDraft};

/// Separates the two `nvidia-smi` queries the probe runs back to back.
pub const GPU_SECTION_SEPARATOR: &str = "@@ESHELL-GPU-APPS@@";

/// Parses the combined output of the two `nvidia-smi` CSV queries.
///
/// Expected shape, with `--format=csv,noheader,nounits`:
///
/// ```text
/// 0, GPU-abc…, NVIDIA A100, 37, 1234, 40960, 52, 78.12, 300.00, [N/A]
/// @@ESHELL-GPU-APPS@@
/// GPU-abc…, 4242, 1024, python
/// ```
///
/// Returns an empty vector for empty output, which is the normal result on a
/// host with no NVIDIA GPU: the probe only runs `nvidia-smi` when it is
/// actually installed.
pub fn parse_gpus(output: &str) -> Vec<GpuStatus> {
    let (gpu_section, apps_section) = match output.split_once(GPU_SECTION_SEPARATOR) {
        Some((gpus, apps)) => (gpus, apps),
        None => (output, ""),
    };

    let mut gpus: Vec<(String, GpuStatus)> = gpu_section
        .lines()
        .filter_map(parse_gpu_row)
        .collect::<Vec<_>>();

    for (uuid, process) in apps_section.lines().filter_map(parse_gpu_process_row) {
        // A card that reports no uuid for its processes still gets them, as long
        // as there is only one card to attribute them to.
        let position = gpus
            .iter()
            .position(|(gpu_uuid, _)| !uuid.is_empty() && gpu_uuid == &uuid)
            .or(if gpus.len() == 1 { Some(0) } else { None });
        if let Some(index) = position {
            gpus[index].1.processes.push(process);
        }
    }

    gpus.into_iter().map(|(_, gpu)| gpu).collect()
}

/// `index, uuid, name, utilization, mem.used, mem.total, temp, power.draw, power.limit, fan`
fn parse_gpu_row(line: &str) -> Option<(String, GpuStatus)> {
    let cols: Vec<&str> = line.split(',').map(str::trim).collect();
    if cols.len() < 3 {
        return None;
    }

    let index = cols[0].parse::<u32>().ok()?;
    let name = cols[2].to_string();
    if name.is_empty() {
        return None;
    }

    let field = |position: usize| cols.get(position).copied().and_then(parse_gpu_number);

    Some((
        cols[1].to_string(),
        GpuStatus {
            index,
            name,
            utilization_percent: field(3),
            memory_used_mb: field(4),
            memory_total_mb: field(5),
            temperature_c: field(6),
            power_draw_w: field(7),
            power_limit_w: field(8),
            fan_percent: field(9),
            processes: Vec::new(),
        },
    ))
}

/// `gpu_uuid, pid, used_gpu_memory, process_name`
fn parse_gpu_process_row(line: &str) -> Option<(String, GpuProcessStatus)> {
    let cols: Vec<&str> = line.split(',').map(str::trim).collect();
    if cols.len() < 4 {
        return None;
    }

    let pid = cols[1].parse::<i32>().ok()?;
    // The process name can itself contain commas, so keep everything after the
    // three fixed columns.
    let command = cols[3..].join(",").trim().to_string();
    if command.is_empty() {
        return None;
    }

    Some((
        cols[0].to_string(),
        GpuProcessStatus {
            pid,
            memory_mb: parse_gpu_number(cols[2]),
            command,
        },
    ))
}

/// `nvidia-smi` writes `[N/A]`, `[Not Supported]` or `[Unknown Error]` for any
/// metric the card or driver does not report.
fn parse_gpu_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('[') {
        return None;
    }
    trimmed.parse::<f64>().ok().map(round2)
}

pub(super) struct GpuProbe;

impl MetricProbe for GpuProbe {
    fn id(&self) -> &'static str {
        "gpu"
    }

    fn command(&self) -> Cow<'static, str> {
        // Guarded by `command -v` so hosts without an NVIDIA driver cost one
        // cheap builtin and return nothing, instead of a "command not found" on
        // every poll. Both queries go in one command to keep this to a single
        // round trip, split by a separator this module also parses.
        Cow::Owned(format!(
            "command -v nvidia-smi >/dev/null 2>&1 && {{ \
               nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits; \
               echo '{GPU_SECTION_SEPARATOR}'; \
               nvidia-smi --query-compute-apps=gpu_uuid,pid,used_gpu_memory,process_name --format=csv,noheader,nounits; \
             }} || true"
        ))
    }

    fn apply(&self, output: &str, draft: &mut ServerStatusDraft) {
        draft.gpus = parse_gpus(output);
    }
}

#[cfg(test)]
mod tests {
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
}
