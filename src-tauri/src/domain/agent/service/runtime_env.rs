use std::process::Stdio;

use tokio::process::Command;

use crate::domain::agent::model::view::{AcpRuntimeEnvView, AcpToolProbeView};

const NODE_COMMAND: &str = if cfg!(windows) { "node.exe" } else { "node" };

// npx is a `.cmd` on Windows, so it has to be probed by its real name.
const NPX_COMMAND: &str = if cfg!(windows) { "npx.cmd" } else { "npx" };

async fn probe_tool(command: &str) -> AcpToolProbeView {
    let output = Command::new(command)
        .arg("--version")
        // Without a null stdin the child blocks waiting for input forever.
        .stdin(Stdio::null())
        .output()
        .await;

    match output {
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

pub async fn probe() -> AcpRuntimeEnvView {
    let (node, npx) = tokio::join!(probe_tool(NODE_COMMAND), probe_tool(NPX_COMMAND));
    AcpRuntimeEnvView {
        ok: node.found && npx.found,
        node,
        npx,
    }
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
        let view = probe().await;
        assert_eq!(view.node.command, NODE_COMMAND);
        assert_eq!(view.npx.command, NPX_COMMAND);
        assert_eq!(view.ok, view.node.found && view.npx.found);
    }
}
