use crate::models::{DiskStatus, MemoryStatus, NetworkInterfaceStatus, ProcessStatus};

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
            let total = extract_metric_value(&lower, " total")?;
            let used = extract_metric_value(&lower, " used")?;
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

/// Parses top process rows from `ps -eo pid,pcpu,pmem,comm --sort=-pcpu`.
pub fn parse_top_processes(output: &str) -> Vec<ProcessStatus> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 4 {
                return None;
            }

            Some(ProcessStatus {
                pid: cols[0].parse::<i32>().ok()?,
                cpu_percent: cols[1].parse::<f64>().ok().map(round2)?,
                memory_percent: cols[2].parse::<f64>().ok().map(round2)?,
                command: cols[3..].join(" "),
            })
        })
        .collect()
}

/// Parses `df -hP` output into filesystem rows.
pub fn parse_disks(output: &str) -> Vec<DiskStatus> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 6 {
                return None;
            }
            if cols[0].eq_ignore_ascii_case("filesystem") {
                return None;
            }
            Some(DiskStatus {
                filesystem: cols[0].to_string(),
                total: cols[1].to_string(),
                used: cols[2].to_string(),
                used_percent: cols[4].to_string(),
                mount_point: cols[5].to_string(),
            })
        })
        .collect()
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

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn parse_top_processes_works() {
        let raw = r#"
PID %CPU %MEM COMMAND
123 12.5 4.1 java
234 5.0 1.2 nginx
"#;
        let rows = parse_top_processes(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 123);
        assert_eq!(rows[0].cpu_percent, 12.5);
    }

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
}
