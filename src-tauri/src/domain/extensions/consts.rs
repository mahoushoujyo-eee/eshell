//! Shared constants for the extension runtime.
//!
//! Every const that used to live in the business files lives here so they
//! stay free of definitions. Paths inside `include_str!` are relative to
//! this file (`src/domain/extensions/`).

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC};

use crate::domain::extensions::service::protocol::AssetKind;

/// `extensions-changed` event name, matching the shared contract.
pub const EXTENSIONS_CHANGED_EVENT: &str = "extensions-changed";

/// `extensions/builtin.json`, verbatim. `include_str!` embeds the shared
/// contract bytes; the file is read again at test time (see [`tests`]) so a
/// drifted embedded copy fails loudly.
pub(crate) const BUILTIN_MANIFEST_JSON: &str = include_str!("../../../../extensions/builtin.json");

/// The extension API version this host implements.
///
/// External manifests must declare exactly this version; a mismatched plugin
/// is skipped at discovery instead of loading half-working.
pub const SUPPORTED_API_VERSION: i64 = 1;

/// The persisted activation state file, `extensions/state.json`.
/// It is a bookkeeping file, not a plugin, and is never discovered or served.
pub const EXTENSION_STATE_FILE: &str = "state.json";

/// Default entry module when a manifest omits `main`.
pub(crate) const DEFAULT_MAIN: &str = "index.js";

/// Default activation when a manifest omits `defaultEnabled`.
pub(crate) const DEFAULT_ENABLED: bool = true;

/// Entry modules must be executable ESM. Asset requests use the wider
/// suffix/MIME allowlist in [`super::protocol`] instead.
pub(crate) const ENTRY_SUFFIXES: [&str; 2] = ["js", "mjs"];

/// The registered scheme name.
pub const PLUGIN_SCHEME: &str = "plugin";

/// Unreserved characters kept verbatim in URL segments.
///
/// Everything else (including `/`, spaces and non-ASCII) is percent-encoded,
/// so an id can never smuggle a path separator into the URL.
pub(crate) const URL_SAFE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The asset allowlist. Entry modules (`js`/`mjs`) are a subset of this.
pub(crate) const ASSET_KINDS: &[AssetKind] = &[
    AssetKind {
        suffix: "js",
        mime: "text/javascript",
    },
    AssetKind {
        suffix: "mjs",
        mime: "text/javascript",
    },
    AssetKind {
        suffix: "css",
        mime: "text/css",
    },
    AssetKind {
        suffix: "json",
        mime: "application/json",
    },
    AssetKind {
        suffix: "map",
        mime: "application/json",
    },
    AssetKind {
        suffix: "html",
        mime: "text/html",
    },
    AssetKind {
        suffix: "txt",
        mime: "text/plain",
    },
    AssetKind {
        suffix: "png",
        mime: "image/png",
    },
    AssetKind {
        suffix: "jpg",
        mime: "image/jpeg",
    },
    AssetKind {
        suffix: "jpeg",
        mime: "image/jpeg",
    },
    AssetKind {
        suffix: "gif",
        mime: "image/gif",
    },
    AssetKind {
        suffix: "svg",
        mime: "image/svg+xml",
    },
    AssetKind {
        suffix: "webp",
        mime: "image/webp",
    },
    AssetKind {
        suffix: "ico",
        mime: "image/x-icon",
    },
];

/// The commands an external plugin may invoke, by exact name.
///
/// Deliberately excluded: `pty_write_input` (raw terminal input),
/// every configuration/credential command, and anything not needed by the
/// facade. `select_upload_file` / `select_download_dir` exist only here.
///
/// `reload_config` is the one config-adjacent command here, and it is
/// read-only: it re-reads files the user already wrote and never returns
/// credentials. A plugin that edits a config file outside the app can ask
/// the host to pick the change up without a restart.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const WHITELIST: &[&str] = &[
    "list_shell_sessions",
    "open_shell_session",
    "close_shell_session",
    "execute_shell_command",
    "sftp_list_dir",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_create_file",
    "sftp_create_directory",
    "sftp_delete_entry",
    "sftp_rename_entry",
    "sftp_download_file",
    "sftp_download_file_to_local",
    "sftp_upload_local_file_with_progress",
    "sftp_cancel_transfer",
    "sftp_default_download_dir",
    "fetch_server_status",
    "get_cached_server_status",
    "select_upload_file",
    "select_download_dir",
    "reload_config",
    "list_reloadable_configs",
];
