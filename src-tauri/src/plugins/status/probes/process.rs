//! Top processes by CPU, from two `top` frames.

use std::borrow::Cow;

use crate::models::ProcessStatus;

use super::text::round2;
use super::{MetricProbe, ServerStatusDraft};

/// Rows the panel keeps. This list is a glance-at-it triage aid, not a process
/// browser, so it stays short.
const MAX_ROWS: usize = 5;

/// Processes that only exist because we asked for a sample. They are matched on
/// the command name, so `/usr/bin/top`, a `top` still running from the previous
/// poll and a `ps aux` the user typed in their own shell are all caught.
///
/// Sampler rows cannot simply be left in and sorted away: their whole lifetime
/// is the sample itself, so they report near-100% CPU and squat the top of the
/// list every single poll.
const SAMPLER_COMMANDS: &[&str] = &["top", "ps", "awk"];

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

#[cfg(test)]
mod tests {
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
}
