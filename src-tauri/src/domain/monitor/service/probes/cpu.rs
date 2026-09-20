//! CPU load and memory, read from a single `top` snapshot.

use std::borrow::Cow;

use crate::domain::monitor::model::MemoryStatus;

use super::text::round2;
use super::{MetricProbe, ServerStatusDraft};

/// Parses `top -bn1` output and extracts CPU usage plus memory totals.
#[allow(dead_code)]
pub fn parse_cpu_and_memory(top_output: &str) -> Option<(f64, MemoryStatus)> {
    let cpu = parse_cpu_percent(top_output)?;
    let memory = parse_memory(top_output)?;
    Some((cpu, memory))
}

/// Parses CPU usage percent from `top -bn1` output.
pub fn parse_cpu_percent(top_output: &str) -> Option<f64> {
    for line in top_output.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("cpu") {
            continue;
        }

        // procps top: "%Cpu(s): ... 96.0 id, ..."
        // busybox top: "CPU: ... 96.0% idle ..."
        let idle = extract_metric_value(&lower, " id")
            .or_else(|| extract_metric_value(&lower, "%id"))
            .or_else(|| extract_metric_value(&lower, " idle"))
            .or_else(|| extract_metric_value(&lower, "%idle"))
            .or_else(|| extract_value_before_keyword(&lower, &["idle", "%idle", "id", "%id"]));

        if let Some(idle_value) = idle {
            let cpu = (100.0 - idle_value).clamp(0.0, 100.0);
            return Some(round2(cpu));
        }
    }

    None
}

/// Parses memory usage from `top -bn1` output and converts values to MiB.
pub fn parse_memory(top_output: &str) -> Option<MemoryStatus> {
    for line in top_output.lines() {
        let lower = line.to_ascii_lowercase();

        // procps top:
        // "MiB Mem : 15935.1 total, 1200.2 free, 4300.0 used, ..."
        if lower.contains("mem") && lower.contains("total") {
            let scale_mb = extract_top_memory_scale_mb(&lower);
            let total = extract_metric_value(&lower, " total")? * scale_mb;
            let used = extract_metric_value(&lower, " used")? * scale_mb;
            return Some(build_memory_status(used, total));
        }

        // busybox top:
        // "Mem: 913392K used, 295116K free, ..."
        if lower.contains("mem:") && lower.contains(" used") && lower.contains(" free") {
            let used = extract_metric_value_mb(&lower, " used")?;
            let free = extract_metric_value_mb(&lower, " free")?;
            let total = used + free;
            return Some(build_memory_status(used, total));
        }
    }

    None
}

fn extract_metric_value(line: &str, suffix: &str) -> Option<f64> {
    for segment in line.split(',') {
        let piece = segment.trim();
        if !piece.ends_with(suffix) {
            continue;
        }
        let without_suffix = piece.trim_end_matches(suffix).trim();
        let number = without_suffix
            .split_whitespace()
            .last()
            .and_then(|token| token.parse::<f64>().ok());
        if let Some(value) = number {
            return Some(value);
        }
    }
    None
}

fn extract_metric_value_mb(line: &str, suffix: &str) -> Option<f64> {
    for segment in line.split(',') {
        let piece = segment.trim();
        if !piece.ends_with(suffix) {
            continue;
        }

        let without_suffix = piece.trim_end_matches(suffix).trim();
        let token = without_suffix.split_whitespace().last()?;
        if let Some(value) = parse_to_mb(token) {
            return Some(value);
        }
    }
    None
}

fn extract_value_before_keyword(line: &str, keywords: &[&str]) -> Option<f64> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for idx in 1..tokens.len() {
        let token = tokens[idx].trim_matches(',').trim_matches(':');
        if !keywords.contains(&token) {
            continue;
        }

        let prev = tokens[idx - 1].trim_matches(',').trim_matches(':');
        if let Ok(value) = prev.trim_end_matches('%').parse::<f64>() {
            return Some(value);
        }
    }
    None
}

fn extract_top_memory_scale_mb(line: &str) -> f64 {
    let prefix = line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches(':');

    match prefix {
        "k" | "kb" | "ki" | "kib" => 1.0 / 1024.0,
        "m" | "mb" | "mi" | "mib" => 1.0,
        "g" | "gb" | "gi" | "gib" => 1024.0,
        "t" | "tb" | "ti" | "tib" => 1024.0 * 1024.0,
        _ => 1.0,
    }
}

fn parse_to_mb(token: &str) -> Option<f64> {
    let lower = token.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }

    let mut split_at = lower.len();
    for (idx, ch) in lower.char_indices() {
        if !ch.is_ascii_digit() && ch != '.' {
            split_at = idx;
            break;
        }
    }

    let number = lower[..split_at].parse::<f64>().ok()?;
    let unit = lower[split_at..].trim();
    let mib = match unit {
        "" | "m" | "mb" | "mi" | "mib" => number,
        "k" | "kb" | "ki" | "kib" => number / 1024.0,
        "g" | "gb" | "gi" | "gib" => number * 1024.0,
        "t" | "tb" | "ti" | "tib" => number * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(mib)
}

fn build_memory_status(used: f64, total: f64) -> MemoryStatus {
    let used_percent = if total <= 0.0 {
        0.0
    } else {
        (used / total * 100.0).min(100.0)
    };
    MemoryStatus {
        used_mb: round2(used),
        total_mb: round2(total),
        used_percent: round2(used_percent),
    }
}

/// CPU load and memory come from one `top` snapshot, so they share a probe.
pub(super) struct CpuMemoryProbe;

impl MetricProbe for CpuMemoryProbe {
    fn id(&self) -> &'static str {
        "cpu_memory"
    }

    fn command(&self) -> Cow<'static, str> {
        // `LANG=C` keeps the field labels parseable on localised hosts.
        Cow::Borrowed("LANG=C top -bn1 | head -n 10")
    }

    fn apply(&self, output: &str, draft: &mut ServerStatusDraft) {
        if let Some(cpu) = parse_cpu_percent(output) {
            draft.cpu_percent = cpu;
        }
        if let Some(memory) = parse_memory(output) {
            draft.memory = memory;
        }
    }
}
