//! Extension runtime: manifest, discovery, activation lifecycle, transport.
//!
//! eShell's SFTP and server-monitoring features ship as built-in extensions;
//! their metadata lives in the single shared manifest `extensions/builtin.json`
//! (see [`manifest`]). External plugins are discovered at startup from
//! `<storage root>/extensions/` (see [`discovery`]), served through the
//! `plugin` URI scheme (see [`protocol`]) and transported through the
//! `invoke_extension_api` broker (see [`broker`]). The runtime owns, per
//! extension (builtin or external):
//!
//! - *Activation*: enabled/disabled, defaults from the manifest, explicit
//!   toggles persisted to `extensions/state.json` (see [`extension_state`]).
//! - *Runtime state*: each extension's operational state lives behind its own
//!   plugin state type (see [`sftp::SftpPluginState`], [`status::StatusPluginState`]),
//!   so `AppState` never manages a feature-specific `HashMap` itself.
//! - *Busy leases*: disabling an extension with work in flight is rejected
//!   (see [`registry::Lease`]); an in-flight task never writes into state that
//!   a disable/re-enable cycle has replaced. The broker holds the *caller's*
//!   lease too, so an external plugin's own operation blocks its disable.

pub(crate) mod broker;
pub(crate) mod commands;
pub(crate) mod discovery;
pub(crate) mod extension_state;
pub(crate) mod install;
pub(crate) mod lifecycle;
pub(crate) mod manifest;
pub(crate) mod mcp_tools;
pub(crate) mod protocol;
pub(crate) mod registry;
pub(crate) mod sftp;
pub(crate) mod status;

/// The runtime view over one extension, combining manifest metadata with the
/// activation flag from the extension registry.
///
/// This is the value the `list_extensions` / `set_extension_enabled` Tauri
/// commands return and the `extensions-changed` event carries. It contains
/// every manifest field plus `enabled`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDescriptor {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub api_version: i64,
    pub builtin: bool,
    pub default_enabled: bool,
    pub enabled: bool,
    pub contributes: manifest::Contributes,
}
