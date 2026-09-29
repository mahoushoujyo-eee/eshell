//! Wire structs for the port-forwarding domain.
//!
//! Field names cross the Tauri boundary as camelCase; the Rust side keeps
//! snake_case. Timestamps are epoch milliseconds, matching the rest of the app.

use serde::{Deserialize, Serialize};

/// Default bind address.
///
/// Loopback by default on purpose: binding `0.0.0.0` publishes the remote
/// service to the whole local network, which is the classic `-L` footgun.
/// Callers opt in explicitly through `bindHost`.
pub const DEFAULT_BIND_HOST: &str = "127.0.0.1";

/// Lifecycle of one forward.
///
/// `Starting` is the state between "row created" and "listener bound"; a bind
/// failure moves straight to `Failed` with `error` set, and the row stays
/// visible so the user can see why instead of watching it silently vanish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardStatus {
    Starting,
    Active,
    Failed,
    Stopped,
}

/// One local forward: `bind_host:bind_port` -> `target_host:target_port`
/// through the SSH connection owned by `session_id`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: String,
    /// Shell tab whose SSH connection carries this forward. The forward dies
    /// with the tab: closing the session stops every forward bound to it.
    pub session_id: String,
    pub bind_host: String,
    /// The port actually bound. When the caller asked for port `0` this is the
    /// OS-assigned port, which is why it is reported back rather than echoed.
    pub bind_port: u16,
    /// Resolved by the server, not by this machine.
    pub target_host: String,
    pub target_port: u16,
    pub status: ForwardStatus,
    /// Human-readable failure reason, set when `status` is `Failed`.
    pub error: Option<String>,
    /// Tunnels currently open through this forward.
    pub active_connections: u32,
    /// Bytes copied client -> target, summed over every tunnel.
    pub bytes_up: u64,
    /// Bytes copied target -> client, summed over every tunnel.
    pub bytes_down: u64,
    pub created_at: i64,
}

/// Runtime counters a tunnel reports back when it ends.
#[derive(Debug, Clone, Copy, Default)]
pub struct TunnelStats {
    pub bytes_up: u64,
    pub bytes_down: u64,
}

/// `create_port_forward` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePortForwardInput {
    pub session_id: String,
    pub target_host: String,
    pub target_port: u16,
    /// Defaults to [`DEFAULT_BIND_HOST`] when omitted or blank.
    #[serde(default)]
    pub bind_host: Option<String>,
    /// `0` (or omitted) asks the OS for a free port.
    #[serde(default)]
    pub bind_port: Option<u16>,
}

/// `stop_port_forward` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopPortForwardInput {
    pub forward_id: String,
}

/// `list_port_forwards` input. Omitted `sessionId` lists every forward.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPortForwardsInput {
    #[serde(default)]
    pub session_id: Option<String>,
}
