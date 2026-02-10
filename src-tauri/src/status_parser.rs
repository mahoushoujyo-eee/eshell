use crate::models::{DiskStatus, MemoryStatus, NetworkInterfaceStatus, ProcessStatus};

/// Parses `top -bn1` output and extracts CPU usage plus memory totals.
pub fn parse_cpu_and_memory(top_output: &str) -> Option<(f64, MemoryStatus)> {
    let mut cpu_percent = None;
    let mut total_mb = None;
    let mut used_mb = None;

    for line in top_output.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("cpu") && lower.contains(" id") {
            // Typical line: "%Cpu(s):  1.4 us, ... 97.9 id, ..."
            if let Some(idle_value) = extract_metric_value(&lower, " id") {
                cpu_percent = Some((100.0 - idle_value).max(0.0));
            }
        }

        if lower.contains("mem") && lower.contains("total") {
            // Typical line: "MiB Mem : 15935.1 total, 1200.2 free, 4300.0 used, ..."
            total_mb = extract_metric_value(&lower, " total");
            used_mb = extract_metric_value(&lower, " used");
        }
    }

    let cpu = cpu_percent?;
    let total = total_mb?;
    let used = used_mb?;
    let used_percent = if total <= 0.0 {
        0.0
    } else {
        (used / total * 100.0).min(100.0)
    };

    Some((
        cpu,
        MemoryStatus {
            used_mb: round2(used),
            total_mb: round2(total),
            used_percent: round2(used_percent),
        },
    ))
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
