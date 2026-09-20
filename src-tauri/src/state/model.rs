//! Shared application-state data structures.
//!
//! [`AppState`] is the dependency container Tauri manages; the types beside it
//! (`SharedSshSession`, `PtyCommand`, `McpBridgeInfo`) are the vocabulary the
//! container and the domain services exchange. Behaviour lives in the
//! `service/` submodules, each implementing one capability of `AppState`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::common::error::AppResult;
use crate::domain::config::Storage;
use crate::domain::extensions::model_manifest::ExtensionCatalog;
use crate::domain::extensions::service::extension_state::ActivationStateStore;
use crate::domain::extensions::service::registry::ExtensionRegistry;
use crate::domain::monitor::service::StatusPlugin;
use crate::domain::agent::model::AcpAgentRegistry;
use crate::domain::sftp::service::SftpPlugin;
use crate::domain::ssh::model::session_model::ShellSession;
use crate::domain::ssh::service::transport::Connection;

/// One long-lived SSH connection, shared by every operation on a shell tab.
///
/// The transport owns the actual socket and a background reader; `Arc` lets the
/// cache and any in-flight operation hold the same handle, while
/// [`Connection::shutdown`] is the explicit close signal (dropping the last
/// `Arc` must not be relied on, because the reader task keeps the socket alive).
pub type SharedSshSession = Arc<Connection>;

#[derive(Debug, Clone)]
pub enum PtyCommand {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// Where the local MCP bridge is listening, plus the per-run bearer token
/// agents must present. Set once at startup by `mcp_bridge::start`.
#[derive(Debug, Clone)]
pub struct McpBridgeInfo {
    pub port: u16,
    pub token: String,
}

/// Shared application state managed by Tauri.
///
/// Design goals:
/// - Keep persistent data concerns in `Storage`.
/// - Keep runtime-only data (shell sessions, status cache) in memory.
/// - Keep core logic testable by not tightly coupling service code to Tauri types.
///
/// Locking:
/// - Every map other than the per-tab connect lock is a plain `std` `RwLock`.
///   Those critical sections are short and synchronous; no guard is ever held
///   across an `.await`.
/// - Establishing a connection is serialized per shell tab with a
///   `tokio::sync::Mutex`, because the handshake is asynchronous (seconds long)
///   and must not block the other tabs' maps.
pub struct AppState {
    pub storage: Storage,
    pub acp_agents: AcpAgentRegistry,
    pub(crate) mcp_bridge: RwLock<Option<McpBridgeInfo>>,
    pub(crate) sessions: RwLock<HashMap<String, ShellSession>>,
    /// One connection per shell tab, keyed by session id only.
    pub(crate) ssh_sessions: RwLock<HashMap<String, SharedSshSession>>,
    /// One lock per shell tab, held across that tab's handshake. Connecting must
    /// not hold `ssh_sessions` itself: a handshake takes seconds and that map is
    /// shared by every tab.
    pub(crate) ssh_connect_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Extension runtime: catalog metadata, activation flags and busy leases.
    /// Feature state itself lives on the plugins below.
    pub(crate) extensions: ExtensionRegistry,
    /// Merged builtin + external catalog.
    ///
    /// Behind a lock because installing or removing a plugin directory
    /// re-scans `extensions/` at runtime: the `plugin://` protocol handler
    /// resolves every asset request through this catalog, so a replaced
    /// catalog must be visible to it without a restart.
    pub(crate) extensions_catalog: RwLock<ExtensionCatalog>,
    /// Persisted explicit activation flags (`extensions/state.json`).
    pub(crate) extension_activation: Mutex<ActivationStateStore>,
    /// SFTP plugin state (transfer cancellation registry). Owned here so the
    /// plugin manages its own maps; `AppState` never touches them directly.
    pub(crate) sftp_plugin: SftpPlugin,
    /// Server-monitor plugin state (status cache). Same ownership rule.
    pub(crate) status_plugin: StatusPlugin,
    /// PTY control channel per shell tab, tagged with the generation of the
    /// worker that registered it. A tab can outlive several PTY workers (see
    /// [`crate::state::service::pty`]), and a worker that is being replaced
    /// must not unregister its successor's channel on the way out.
    pub(crate) pty_channels: RwLock<HashMap<String, (u64, UnboundedSender<PtyCommand>)>>,
    /// Source of [`AppState::pty_channels`] generations. Monotonic, never reset.
    pub(crate) pty_generations: AtomicU64,
    /// Cancellation token per shell tab. Created by `put_session`, never reset by
    /// later updates, and cancelled by `remove_session`.
    pub(crate) shell_session_tokens: RwLock<HashMap<String, CancellationToken>>,
    pub(crate) shell_connection_cancellations: RwLock<HashMap<String, CancellationToken>>,
    pub(crate) ki_pending: RwLock<HashMap<String, oneshot::Sender<Vec<String>>>>,
}

impl AppState {
    /// Creates a fully initialized state object backed by a storage root path.
    pub fn new(storage_root: PathBuf) -> AppResult<Self> {
        let extensions_catalog = super::service::extensions::build_extension_catalog(&storage_root)?;
        let extensions_dir = storage_root.join("extensions");
        let extension_activation = ActivationStateStore::load(&extensions_dir);
        let extensions = ExtensionRegistry::from_catalog(&extensions_catalog);
        // Seed persisted flags: a restart resumes exactly the last committed
        // activation, builtin or external, without looking like a change.
        for id in extensions_catalog.iter_ids() {
            if let Some(enabled) = extension_activation.get(&id) {
                extensions.seed_persisted(&id, enabled);
            }
        }
        Ok(Self {
            storage: Storage::new(storage_root.clone())?,
            acp_agents: AcpAgentRegistry::new(),
            mcp_bridge: RwLock::new(None),
            sessions: RwLock::new(HashMap::new()),
            ssh_sessions: RwLock::new(HashMap::new()),
            ssh_connect_locks: Mutex::new(HashMap::new()),
            extensions,
            extensions_catalog: RwLock::new(extensions_catalog),
            extension_activation: Mutex::new(extension_activation),
            sftp_plugin: SftpPlugin::new(),
            status_plugin: StatusPlugin::new(),
            pty_channels: RwLock::new(HashMap::new()),
            pty_generations: AtomicU64::new(0),
            shell_session_tokens: RwLock::new(HashMap::new()),
            shell_connection_cancellations: RwLock::new(HashMap::new()),
            ki_pending: RwLock::new(HashMap::new()),
        })
    }
}
