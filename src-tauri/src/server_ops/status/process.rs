//! Top processes by CPU, from `ps`.

use std::borrow::Cow;

use crate::models::ProcessStatus;

use super::text::round2;
use super::{MetricProbe, ServerStatusDraft};

/// Parses top process rows from `ps -eo pid,pcpu,rss,comm --sort=-pcpu`.
///
/// The `ps` process itself always shows up in its own output with a wildly
/// inflated %CPU (its lifetime is milliseconds, so the lifetime-average CPU
/// ratio `ps` reports is meaningless). It's sampler noise, not real load —
/// drop the row.
pub fn parse_top_processes(output: &str) -> Vec<ProcessStatus> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 4 {
                return None;
            }

            let command = cols[3..].join(" ");
            if command == "ps" {
                return None;
            }

            Some(ProcessStatus {
                pid: cols[0].parse::<i32>().ok()?,
                cpu_percent: cols[1].parse::<f64>().ok().map(round2)?,
                memory_mb: cols[2]
                    .parse::<f64>()
                    .ok()
                    .map(|value_kb| round2(value_kb / 1024.0))?,
                command,
            })
        })
        .collect()
}

pub(super) struct ProcessProbe;

impl MetricProbe for ProcessProbe {
    fn id(&self) -> &'static str {
        "process"
    }

    fn command(&self) -> Cow<'static, str> {
        Cow::Borrowed("ps -eo pid,pcpu,rss,comm --sort=-pcpu | head -n 5")
    }

    fn apply(&self, output: &str, draft: &mut ServerStatusDraft) {
        draft.top_processes = parse_top_processes(output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_top_processes_works() {
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
    fn parse_top_processes_drops_ps_itself() {
        let raw = r#"
PID %CPU RSS COMMAND
106721 1300.0 4400 ps
123 12.5 41984 java
"#;
        let rows = parse_top_processes(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "java");
    }
}
