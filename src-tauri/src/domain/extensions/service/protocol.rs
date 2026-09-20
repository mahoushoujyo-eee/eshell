//! The `plugin` custom URI scheme: serves external plugin bundles.
//!
//! URL shape (Windows): `http://plugin.localhost/<percent-encoded-id>/<main>`
//! Other desktop platforms: `plugin://localhost/<percent-encoded-id>/<main>`
//! (Tauri maps a registered `plugin` scheme to `http://plugin.localhost` on
//! Windows/Android and `plugin://localhost` elsewhere).
//!
//! Rules, enforced per request:
//! - the id segment must decode to an id in the discovered catalog — only
//!   discovered plugin directories are served, resolution goes through the
//!   catalog's id -> directory map, never a concatenation of the id itself;
//! - the requested path must canonicalize *inside that plugin's canonical
//!   directory (`Path::starts_with`, not string prefixing), so symlinks and
//!   `..` that resolve outside are refused, and `extensions/state.json` (or
//!   any file that is not under a plugin directory) can never be reached;
//! - the suffix must be on the explicit allowlist, mapping to its MIME type;
//! - JS/MJS are served as `text/javascript` with CORS
//!   `Access-Control-Allow-Origin: *` so a same-origin dynamic `import()`
//!   from the app page works in production;
//! - every response carries `Cache-Control: no-store`, because there is no
//!   hot reload: a restart must load the current files, never a stale cache.
//!
//! Unknown/invalid/missing resources answer an HTTP error, never a panic.

use std::path::Path;

use percent_encoding::utf8_percent_encode;

use crate::domain::extensions::consts::*;
use crate::domain::extensions::model_manifest::{DiscoveredPlugin, ExtensionCatalog};
use crate::common::error::AppResult;

/// The response type produced by the scheme handler.
///
/// An alias so the decision functions do not carry `Response<Vec<u8>>>`
/// generic nests that trip the `>>` parser.
pub type PluginResponse = tauri::http::Response<Vec<u8>>;

/// One allowed asset suffix and its MIME type.
pub(crate) struct AssetKind {
    pub(crate) suffix: &'static str,
    pub(crate) mime: &'static str,
}

/// Percent-encodes one path segment (unreserved set, `/` encoded).
fn encode_segment(segment: &str) -> String {
    utf8_percent_encode(segment, URL_SAFE).to_string()
}

/// Percent-encodes an id for the URL's first segment.
pub fn encode_extension_id(extension_id: &str) -> String {
    encode_segment(extension_id)
}

/// Percent-encodes a relative main path, preserving `/` separators.
pub fn encode_main_path(main: &str) -> String {
    main.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// The platform bundle URL for one external plugin.
///
/// Windows: `http://plugin.localhost/<encoded-id>/<encoded-main>`.
/// Other supported desktops: `plugin://localhost/<encoded-id>/<encoded-main>`.
pub fn bundle_url(plugin: &DiscoveredPlugin) -> String {
    let origin = if cfg!(windows) {
        "http://plugin.localhost"
    } else {
        "plugin://localhost"
    };
    format!(
        "{origin}/{}/{}",
        encode_extension_id(&plugin.entry.id),
        encode_main_path(&plugin.entry.main)
    )
}

/// Serves one `/<encoded-id>/<encoded-main>` request path.
///
/// Pure function over the catalog; the Tauri protocol handler is a thin
/// wrapper (see [`register_plugin_scheme`]), which is what makes the
/// path/CORS/MIME rules unit-testable without a WebView.
pub fn serve_extension_asset(catalog: &ExtensionCatalog, request_path: &str) -> PluginResponse {
    respond(serve_extension_asset_inner(catalog, request_path))
}

/// The decision core: `Ok(bytes, mime)` or an HTTP error response.
fn serve_extension_asset_inner(
    catalog: &ExtensionCatalog,
    request_path: &str,
) -> Result<(Vec<u8>, &'static str), (tauri::http::StatusCode, String)> {
    let trimmed = request_path.trim_start_matches('/');
    let (id_segment, main_segment) = trimmed
        .split_once('/')
        .ok_or_else(|| error_response(tauri::http::StatusCode::NOT_FOUND, "unknown plugin"))?;
    let extension_id = percent_encoding::percent_decode_str(id_segment)
        .decode_utf8()
        .map_err(|_| error_response(tauri::http::StatusCode::NOT_FOUND, "invalid id encoding"))?
        .to_string();

    let plugin = catalog.find_external(&extension_id).ok_or_else(|| {
        error_response(
            tauri::http::StatusCode::NOT_FOUND,
            "unknown plugin",
        )
    })?;

    // Only relative paths with no `..`/root component reach the filesystem.
    let main = percent_encoding::percent_decode_str(main_segment)
        .decode_utf8()
        .map_err(|_| error_response(tauri::http::StatusCode::NOT_FOUND, "invalid path encoding"))?
        .to_string();
    let rel = Path::new(&main);
    if rel.is_absolute()
        || main.contains('\\')
        || rel.components().any(|component| {
            matches!(component, std::path::Component::ParentDir)
        })
    {
        return Err(error_response(
            tauri::http::StatusCode::FORBIDDEN,
            "path escapes the plugin directory",
        ));
    }

    // Anchor check: the *stored* discovery-time canonical directory is the
    // only trusted root. A directory that was replaced or re-pointed after
    // discovery (a new symlink/junction target) is refused here — the current
    // on-disk location is never re-anchored, so pointing the plugin directory
    // at, say, `.eshell-data` cannot smuggle `ssh_configs.json` in as a
    // plugin asset, and `extensions/state.json` stays unreachable.
    let current_dir = std::fs::canonicalize(&plugin.dir).map_err(|_| {
        error_response(tauri::http::StatusCode::NOT_FOUND, "plugin directory missing")
    })?;
    if current_dir != plugin.canonical_dir {
        return Err(error_response(
            tauri::http::StatusCode::FORBIDDEN,
            "plugin directory changed after discovery",
        ));
    }

    // Containment against the stored anchor, per request. Regular file
    // updates *inside* the anchored root stay allowed; anything resolving
    // outside it (an in-directory symlink escape) is refused.
    let target = plugin.dir.join(rel);
    let canonical_target = std::fs::canonicalize(&target).map_err(|_| {
        error_response(tauri::http::StatusCode::NOT_FOUND, "resource not found")
    })?;
    if !canonical_target.starts_with(&plugin.canonical_dir) || !canonical_target.is_file() {
        return Err(error_response(
            tauri::http::StatusCode::FORBIDDEN,
            "resource is outside the plugin directory",
        ));
    }

    // state.json can never match: it lives directly under extensions/, which
    // is not *inside* any plugin directory; the containment check above is the
    // enforcement. (Stated here because it is a contract item, not a TODO.)
    let kind = asset_kind(&canonical_target).ok_or_else(|| {
        error_response(
            tauri::http::StatusCode::FORBIDDEN,
            "resource type is not allowed",
        )
    })?;

    let bytes = std::fs::read(&canonical_target)
        .map_err(|_| error_response(tauri::http::StatusCode::NOT_FOUND, "resource not found"))?;
    Ok((bytes, kind.mime))
}

/// The allowlisted kind for a path, by suffix.
fn asset_kind(path: &Path) -> Option<&'static AssetKind> {
    let suffix = path.extension()?.to_str()?.to_ascii_lowercase();
    ASSET_KINDS
        .iter()
        .find(|kind| kind.suffix == suffix)
}

/// A plain-text error value. Never a panic; missing plugins/files are a
/// normal condition for a user-managed directory.
fn error_response(status: tauri::http::StatusCode, message: &str) -> (tauri::http::StatusCode, String) {
    (status, message.to_string())
}

fn respond(outcome: Result<(Vec<u8>, &'static str), (tauri::http::StatusCode, String)>) -> PluginResponse {
    use tauri::http::{header, Response, StatusCode};
    match outcome {
        Ok((body, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            // No hot reload: a restart must never serve a stale entry module.
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .expect("static response parts"),
        Err((status, message)) => {
            let mime = "text/plain; charset=utf-8";
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CACHE_CONTROL, "no-store")
                .body(message.into_bytes())
                .expect("static response parts")
        }
    }
}

/// Registers the `plugin` URI scheme on the application builder.
///
/// The handler resolves through the managed [`crate::state::AppState`]'s
/// catalog, so the served set is exactly the discovered, validated plugins.
/// Work runs on a worker thread and answers through the async responder; the
/// registry lock is never held across the file IO.
pub fn register_plugin_scheme<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    use tauri::Manager;
    builder.register_asynchronous_uri_scheme_protocol(PLUGIN_SCHEME, move |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let path = request.uri().path().to_string();
        std::thread::spawn(move || {
            let state = app
                .try_state::<std::sync::Arc<crate::state::AppState>>()
                .expect("managed app state");
            // A snapshot: an install or uninstall can swap the catalog
            // between requests, and this one must resolve against a single
            // consistent view rather than a half-updated one.
            let catalog = state.extensions_catalog();
            responder.respond(serve_extension_asset(&catalog, &path));
        });
    })
}

/// Unused today; kept for callers that need the raw response type.
#[allow(dead_code)]
fn _response_type_assert(_: AppResult<()>) {}

/// Percent-decoding helper kept for tests that need round-trip checks.
#[cfg(test)]
pub(crate) fn decode_segment(segment: &str) -> String {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .expect("test segments are valid utf-8")
        .to_string()
}


