//! Constants for the server-monitor domain: poll budget, batch-script
//! section markers and probe tuning knobs.

use std::time::Duration;

/// Extension id from `extensions/builtin.json`.
pub const EXTENSION_ID: &str = "eshell.server-monitor";

/// How long one poll's batched command may take before it is abandoned.
///
/// The generic session-command budget is 30 minutes, which is right for a
/// command the user typed and wrong for a poll: a stalled link would leave the
/// panel frozen for the rest of the session. The batch is five cheap commands
/// plus the process probe's deliberate half-second sample, so this is a
/// generous ceiling that only a genuinely wedged host or link reaches.
pub(crate) const POLL_TIMEOUT: Duration = Duration::from_secs(20);

/// Prefix of the marker line that separates one probe's output section from
/// the next inside the batched script.
///
/// The marker is echoed by the remote shell and matched on its own line, so a
/// section that produced no output at all still leaves its marker behind: a
/// probe that printed nothing stays distinguishable from a probe that never
/// ran.
pub(crate) const SECTION_MARKER_PREFIX: &str = "@@ESHELL-PROBE:";

/// Separates the two `nvidia-smi` queries the GPU probe runs back to back.
pub(crate) const GPU_SECTION_SEPARATOR: &str = "@@ESHELL-GPU-APPS@@";

/// Rows the process probe keeps. This list is a glance-at-it triage aid, not a
/// process browser, so it stays short.
pub(crate) const MAX_ROWS: usize = 5;

/// Processes that only exist because we asked for a sample. They are matched on
/// the command name, so `/usr/bin/top`, a `top` still running from the previous
/// poll and a `ps aux` the user typed in their own shell are all caught.
///
/// Sampler rows cannot simply be left in and sorted away: their whole lifetime
/// is the sample itself, so they report near-100% CPU and squat the top of the
/// list every single poll.
pub(crate) const SAMPLER_COMMANDS: &[&str] = &["top", "ps", "awk"];
