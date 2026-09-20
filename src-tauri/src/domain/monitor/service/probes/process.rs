//! Top processes by CPU, from two `top` frames.

use std::borrow::Cow;

use crate::domain::monitor::model::ProcessStatus;
use crate::domain::monitor::consts::*;

use super::text::round2;
use super::{MetricProbe, ServerStatusDraft};

/// Parses the process table out of a `top` listing (or a `ps` one, which has
/// the same shape).
///
/// Only the last frame in the output is read. `top -b -n2` prints two, and the
/// first frame's `%CPU` is the since-boot average — a service pinned at 100%
/// for a week still averages out to near nothing there, which is why the panel
/// looked frozen. The second frame is measured against the first, so it is the
/// live value the panel is meant to show.
///
/// Columns are located by header name, never by position: procps prints
/// `PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND` while busybox prints
/// `PID PPID USER STAT VSZ %VSZ %CPU COMMAND`, so a fixed index that means
/// `%CPU` on one host reads busybox's `%VSZ` on the other.
pub fn parse_top_processes(output: &str) -> Vec<ProcessStatus> {
    let lines: Vec<&str> = output.lines().collect();
    let Some(header_at) = lines.iter().rposition(|line| is_header(line)) else {
        return Vec::new();
    };
    let Some(columns) = ProcessColumns::from_header(lines[header_at]) else {
        return Vec::new();
    };

    let mut rows: Vec<ProcessStatus> = lines[header_at + 1..]
        .iter()
        .filter_map(|line| parse_row(line, &columns))
        .collect();

    // `top` already sorts by CPU and `ps` only does when asked to, so sorting
    // here is what makes the cap keep the busiest rows whatever produced the
    // listing.
    rows.sort_by(|left, right| right.cpu_percent.total_cmp(&left.cpu_percent));
    rows.truncate(MAX_ROWS);
    rows
}

/// Where the fields we need sit in one particular `top`'s table.
struct ProcessColumns {
    pid: usize,
    cpu: usize,
    memory: Option<usize>,
    command: usize,
}

impl ProcessColumns {
    fn from_header(header: &str) -> Option<Self> {
        let fields: Vec<String> = header
            .split_whitespace()
            .map(|field| field.to_ascii_uppercase())
            .collect();
        let column = |names: &[&str]| {
            fields
                .iter()
                .position(|field| names.contains(&field.as_str()))
        };

        Some(Self {
            pid: column(&["PID"])?,
            // Only the percentage spellings count: busybox's SMP build also has
            // a bare `CPU` column, and that one holds a core number.
            cpu: column(&["%CPU", "CPU%"])?,
            // busybox has no resident size to offer. `VSZ` overstates what the
            // process actually holds, but it keeps the column populated instead
            // of showing a table of zeroes.
            memory: column(&["RES", "RSS"]).or_else(|| column(&["VSZ", "VSIZE"])),
            command: column(&["COMMAND", "CMD"])?,
        })
    }
}

fn parse_row(line: &str, columns: &ProcessColumns) -> Option<ProcessStatus> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() <= columns.command {
        return None;
    }
    let field = |index: usize| fields.get(index).copied();

    // The command is last in every layout, and busybox puts the whole command
    // line there, spaces and all.
    let command = fields[columns.command..].join(" ");
    if is_sampler(&command) {
        return None;
    }

    Some(ProcessStatus {
        pid: field(columns.pid)?.parse::<i32>().ok()?,
        cpu_percent: parse_percent(field(columns.cpu)?)?,
        memory_mb: columns
            .memory
            .and_then(field)
            .and_then(parse_size_mb)
            .unwrap_or(0.0),
        command,
    })
}

/// The header is the row whose first field is `PID`; process rows always start
/// with a number.
fn is_header(line: &str) -> bool {
    line.split_whitespace()
        .next()
        .is_some_and(|field| field.eq_ignore_ascii_case("PID"))
}

fn is_sampler(command: &str) -> bool {
    let Some(first) = command.split_whitespace().next() else {
        return false;
    };
    // busybox brackets the script a shell is running (`{run.sh}`), and kernel
    // threads come bracketed too (`[kworker/0:1]`).
    let name = first.trim_matches(|ch| matches!(ch, '{' | '}' | '[' | ']'));
    let name = name.rsplit('/').next().unwrap_or(name);
    SAMPLER_COMMANDS.contains(&name)
}

/// busybox writes `12%` where procps writes `12.0`, and a stray `%` reaching
/// `parse` would drop the row entirely.
fn parse_percent(value: &str) -> Option<f64> {
    value.trim_end_matches('%').parse::<f64>().ok().map(round2)
}

/// Task memory is in KiB unless `top` scaled it to fit the column, in which
/// case it carries a unit suffix (`1.2g`).
fn parse_size_mb(value: &str) -> Option<f64> {
    let value = value.trim();
    let split_at = value
        .find(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .unwrap_or(value.len());
    let number = value[..split_at].parse::<f64>().ok()?;

    let kib = match value[split_at..].to_ascii_lowercase().as_str() {
        "" | "k" | "kb" | "kib" => number,
        "m" | "mb" | "mib" => number * 1024.0,
        "g" | "gb" | "gib" => number * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => number * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(round2(kib / 1024.0))
}

pub(super) struct ProcessProbe;

impl MetricProbe for ProcessProbe {
    fn id(&self) -> &'static str {
        "process"
    }

    fn command(&self) -> Cow<'static, str> {
        // Two frames half a second apart, because only the second one carries a
        // live `%CPU` (see `parse_top_processes`).
        //
        // busybox's `top` takes neither `-w` nor a fractional `-d`, and it
        // answers an option it does not know by printing usage and exiting —
        // no frames at all — hence the plainer retry. Its one-second sample is
        // slower but it is the only form both implementations accept.
        //
        // `awk` keeps the last frame only and caps it, so a host running a
        // thousand processes does not push a quarter of a megabyte through the
        // SSH channel every poll. The header line has to survive the trim: the
        // parser needs it to know which column is which.
        Cow::Borrowed(
            "{ LANG=C top -b -n2 -d0.5 -w512 2>/dev/null || LANG=C top -b -n2 -d1 2>/dev/null; } \
             | awk '\n\
             /^ *PID/ { seen = 1; frame = \"\"; rows = 0 }\n\
             seen && rows < 14 { frame = frame $0 \"\\n\"; rows++ }\n\
             END { printf \"%s\", frame }'",
        )
    }

    fn apply(&self, output: &str, draft: &mut ServerStatusDraft) {
        draft.top_processes = parse_top_processes(output);
    }
}
