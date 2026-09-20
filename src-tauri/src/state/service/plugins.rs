//! Plugin-state accessors and the MCP bridge endpoint on `AppState`.
//!
//! `AppState` hands out references to each builtin plugin's own state and
//! never touches the plugin's maps; the MCP bridge endpoint is recorded here
//! once at startup for the ACP integration to inject.

use crate::domain::monitor::service::StatusPlugin;
use crate::domain::sftp::service::SftpPlugin;
use crate::state::model::{AppState, McpBridgeInfo};

impl AppState {
    /// Records where the local MCP bridge listens.
    pub fn set_mcp_bridge(&self, info: McpBridgeInfo) {
        *self.mcp_bridge.write().expect("mcp bridge lock poisoned") = Some(info);
    }

    /// Returns the local MCP bridge endpoint, if it started successfully.
    pub fn mcp_bridge(&self) -> Option<McpBridgeInfo> {
        self.mcp_bridge
            .read()
            .expect("mcp bridge lock poisoned")
            .clone()
    }

    /// The SFTP plugin (transfer cancellation registry).
    pub fn sftp_plugin(&self) -> &SftpPlugin {
        &self.sftp_plugin
    }

    /// The server-monitor plugin (status cache).
    pub fn status_plugin(&self) -> &StatusPlugin {
        &self.status_plugin
    }
}
