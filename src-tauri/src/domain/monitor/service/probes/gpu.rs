//! NVIDIA GPU metrics and compute processes, from `nvidia-smi`.

use std::borrow::Cow;

use crate::domain::monitor::model::{GpuProcessStatus, GpuStatus};
use crate::domain::monitor::consts::*;

use super::text::round2;
use super::{MetricProbe, ServerStatusDraft};

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
