use std::process::Stdio;
use std::sync::OnceLock;

use tokio::process::Command;
use tokio::sync::Mutex;

use crate::domain::agent::model::view::{AcpRuntimeEnvView, AcpToolProbeView};

const NODE_COMMAND: &str = if cfg!(windows) { "node.exe" } else { "node" };

// npx is a `.cmd` on Windows, so it has to be probed by its real name.
const NPX_COMMAND: &str = if cfg!(windows) { "npx.cmd" } else { "npx" };

// The app is a GUI-subsystem binary, so it has no console of its own. Without
// this flag Windows gives every console child a new console *window*: the two
// probes below flashed two black windows on every panel open.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

async fn probe_tool(command: &str) -> AcpToolProbeView {
    let mut child = Command::new(command);
    child.arg("--version");
    // Without a null stdin the child blocks waiting for input forever.
    child.stdin(Stdio::null());
    #[cfg(windows)]
    child.creation_flags(CREATE_NO_WINDOW);

    match child.output().await {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToString::to_string);
            AcpToolProbeView {
                found: true,
                command: command.to_string(),
                version,
            }
        }
        Err(_) => AcpToolProbeView {
            found: false,
            command: command.to_string(),
            version: None,
        },
    }
}

async fn probe_uncached() -> AcpRuntimeEnvView {
    let (node, npx) = tokio::join!(probe_tool(NODE_COMMAND), probe_tool(NPX_COMMAND));
    AcpRuntimeEnvView {
        ok: node.found && npx.found,
        node,
        npx,
    }
}

/// The last probe, kept for the rest of the process.
///
/// The panel asks on every open, and whether Node.js is installed cannot change
/// between two opens. Re-running it meant spawning two processes each time.
fn cache() -> &'static Mutex<Option<AcpRuntimeEnvView>> {
    static CACHE: OnceLock<Mutex<Option<AcpRuntimeEnvView>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Probes the Node.js toolchain, reusing the first answer.
///
/// `force` is for the panel's "check again" button, which exists precisely
/// because the user may have just installed Node.js.
pub async fn probe(force: bool) -> AcpRuntimeEnvView {
    let mut cached = cache().lock().await;
    if !force {
        if let Some(view) = cached.as_ref() {
            return view.clone();
        }
    }
    let view = probe_uncached().await;
    *cached = Some(view.clone());
    view
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_executable_is_reported_missing() {
        let probe = probe_tool("eshell-no-such-tool-xyz").await;
        assert!(!probe.found);
        assert_eq!(probe.version, None);
        assert_eq!(probe.command, "eshell-no-such-tool-xyz");
    }

    #[tokio::test]
    async fn probes_report_their_own_command() {
        let view = probe(true).await;
        assert_eq!(view.node.command, NODE_COMMAND);
        assert_eq!(view.npx.command, NPX_COMMAND);
        assert_eq!(view.ok, view.node.found && view.npx.found);
    }

    /// A second look must not spawn anything: that is the whole point of the
    /// cache, since the panel asks on every open.
    #[tokio::test]
    async fn the_probe_is_cached_until_forced() {
        let first = probe(true).await;
        let second = probe(false).await;
        assert_eq!(first.ok, second.ok);
        assert_eq!(first.node.found, second.node.found);
        assert_eq!(first.node.version, second.node.version);
    }
}
