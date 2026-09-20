//! Filesystem usage from `df`.

use std::borrow::Cow;

use crate::domain::monitor::model::DiskStatus;

use super::{MetricProbe, ServerStatusDraft};

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

pub(super) struct DiskProbe;

impl MetricProbe for DiskProbe {
    fn id(&self) -> &'static str {
        "disk"
    }

    fn command(&self) -> Cow<'static, str> {
        Cow::Borrowed("df -hP")
    }

    fn apply(&self, output: &str, draft: &mut ServerStatusDraft) {
        draft.disks = parse_disks(output);
    }
}
