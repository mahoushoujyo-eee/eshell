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

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use super::manifest::{DiscoveredPlugin, ExtensionCatalog};
use crate::error::AppResult;

/// The registered scheme name.
pub const PLUGIN_SCHEME: &str = "plugin";

/// The response type produced by the scheme handler.
///
/// An alias so the decision functions do not carry `Response<Vec<u8>>>`
/// generic nests that trip the `>>` parser.
pub type PluginResponse = tauri::http::Response<Vec<u8>>;

/// Unreserved characters kept verbatim in URL segments.
///
/// Everything else (including `/`, spaces and non-ASCII) is percent-encoded,
/// so an id can never smuggle a path separator into the URL.
const URL_SAFE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// One allowed asset suffix and its MIME type.
struct AssetKind {
    suffix: &'static str,
    mime: &'static str,
}

/// The asset allowlist. Entry modules (`js`/`mjs`) are a subset of this.
const ASSET_KINDS: &[AssetKind] = &[
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


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use crate::plugins::manifest::{
        BuiltinManifest, Contributes, ExternalExtensionEntry, SUPPORTED_API_VERSION,
    };

    fn temp_catalog(name: &str) -> (PathBuf, ExtensionCatalog) {
        let root = std::env::temp_dir().join(format!(
            "eshell-protocol-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = root.join("extensions").join("a-plugin-dir");
        std::fs::create_dir_all(plugin_dir.join("assets")).expect("create plugin tree");
        std::fs::write(plugin_dir.join("index.js"), b"export default 1;")
            .expect("write entry");
        std::fs::write(plugin_dir.join("assets").join("app.js"), b"export const x = 2;")
            .expect("write asset");
        std::fs::write(plugin_dir.join("assets").join("style.css"), b"body{}")
            .expect("write css");
        std::fs::write(plugin_dir.join("assets").join("logo.svg"), b"<svg/>")
            .expect("write svg");
        std::fs::write(
            root.join("extensions").join(super::super::discovery::EXTENSION_STATE_FILE),
            "{}",
        )
        .expect("write state file");

        let plugin = DiscoveredPlugin {
            entry: ExternalExtensionEntry {
                id: "com.example.plugin".to_string(),
                display_name: "Example".to_string(),
                version: "1.0.0".to_string(),
                api_version: SUPPORTED_API_VERSION,
                builtin: false,
                default_enabled: true,
                main: "index.js".to_string(),
                contributes: Contributes::default(),
            },
            dir: plugin_dir.clone(),
            canonical_dir: std::fs::canonicalize(&plugin_dir).expect("canonicalize plugin dir"),
        };
        let catalog = ExtensionCatalog {
            builtin: BuiltinManifest::parse().expect("manifest"),
            external: vec![plugin],
        };
        (root, catalog)
    }

    fn get(response: &tauri::http::Response<Vec<u8>>, header: &str) -> String {
        String::from_utf8_lossy(
            response
                .headers()
                .get(header)
                .map(|value| value.as_bytes())
                .unwrap_or_default(),
        )
        .to_string()
    }

    /// Happy path: entry module served as JavaScript with CORS + no-store.
    #[test]
    fn entry_module_is_served_as_javascript_with_cors() {
        let (_root, catalog) = temp_catalog("entry");
        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(get(&response, "content-type"), "text/javascript");
        assert_eq!(get(&response, "access-control-allow-origin"), "*");
        assert_eq!(get(&response, "cache-control"), "no-store");
        assert_eq!(response.body(), b"export default 1;");
    }

    /// Nested assets inherit the same headers with their own MIME types.
    #[test]
    fn nested_assets_use_allowlisted_mime_types() {
        let (_root, catalog) = temp_catalog("assets");
        for (path, mime, body) in [
            (
                "/com.example.plugin/assets/app.js",
                "text/javascript",
                b"export const x = 2;".as_slice(),
            ),
            ("/com.example.plugin/assets/style.css", "text/css", b"body{}"),
            (
                "/com.example.plugin/assets/logo.svg",
                "image/svg+xml",
                b"<svg/>",
            ),
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert_eq!(response.status(), tauri::http::StatusCode::OK, "{path}");
            assert_eq!(get(&response, "content-type"), mime, "{path}");
            assert_eq!(response.body(), body, "{path}");
            assert_eq!(get(&response, "cache-control"), "no-store", "{path}");
        }
    }

    /// Unknown plugins, unknown resources and non-allowlisted types are HTTP
    /// errors, never panics; the state file is not reachable.
    #[test]
    fn unknown_and_disallowed_resources_answer_http_errors() {
        let (root, catalog) = temp_catalog("errors");
        let cases = [
            "/com.example.missing/index.js",
            "/com.example.plugin/nothing.js",
            "/com.example.plugin/assets/style.scss",
            "/com.example.plugin/../../state.json",
            "/",
            "/com.example.plugin",
        ];
        for path in cases {
            let response = serve_extension_asset(&catalog, path);
            assert_ne!(response.status(), tauri::http::StatusCode::OK, "{path}");
        }

        // The state file under extensions/ is never served: it is not inside
        // any plugin directory, and no id resolves to it.
        let state_path = root
            .join("extensions")
            .join(super::super::discovery::EXTENSION_STATE_FILE);
        let response = serve_extension_asset(
            &catalog,
            &format!(
                "/com.example.plugin/{}",
                state_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
            ),
        );
        assert_ne!(response.status(), tauri::http::StatusCode::OK);
    }

    /// `..` and absolute paths are refused before touching the filesystem.
    #[test]
    fn escapes_are_refused() {
        let (_root, catalog) = temp_catalog("escape");
        for path in [
            "/com.example.plugin/..%2F..%2Fstate.json",
            "/com.example.plugin/%2e%2e/index.js",
            "/com.example.plugin//etc/passwd.js",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert!(
                response.status() == tauri::http::StatusCode::FORBIDDEN
                    || response.status() == tauri::http::StatusCode::NOT_FOUND,
                "{path}"
            );
            assert_ne!(response.status(), tauri::http::StatusCode::OK, "{path}");
        }
    }

    /// A symlinked asset pointing outside the plugin directory is refused by
    /// the canonical containment check.
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn symlink_escape_is_refused() {
        let (root, catalog) = temp_catalog("symlink");
        let outside = root.join("outside-secret.js");
        std::fs::write(&outside, b"secret").expect("write outside");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");
        std::os::unix::fs::symlink(&outside, plugin_dir.join("linked.js")).expect("symlink");

        let response = serve_extension_asset(&catalog, "/com.example.plugin/linked.js");
        assert_eq!(response.status(), tauri::http::StatusCode::FORBIDDEN);
        assert_ne!(response.body(), b"secret");
    }

    /// A directory *re-pointed* after discovery is refused: the stored
    /// canonical directory is the only trusted root, and a plugin directory
    /// that no longer resolves to it (removed and recreated as a link to the
    /// storage root, or anywhere else) never has its new target adopted.
    ///
    /// Windows junctions exercise the same check; creating them needs
    /// privileges in tests, so QA covers that platform (the check itself is
    /// platform-shared: `canonicalize` resolves junctions and symlinks alike).
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn redirected_directory_after_discovery_is_refused() {
        let (root, catalog) = temp_catalog("redirected-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // The attacker's target: the storage root, holding ssh_configs.json
        // and state.json that must never become plugin assets.
        std::fs::write(
            root.join("ssh_configs.json"),
            b"[{\"host\":\"storage-root\"}]",
        )
        .expect("write storage root file");

        // Re-point the plugin directory at it: remove the real directory and
        // put a symlink in its place.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::os::unix::fs::symlink(&root, &plugin_dir).expect("symlink plugin dir");

        // Every request through the re-pointed directory is refused: the
        // anchor check compares the *current* resolved directory against the
        // stored discovery-time root, so the new target is not re-anchored.
        for path in [
            "/com.example.plugin/index.js",
            "/com.example.plugin/ssh_configs.json",
            "/com.example.plugin/state.json",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert_eq!(
                response.status(),
                tauri::http::StatusCode::FORBIDDEN,
                "{path}"
            );
            assert!(
                response.body() != b"[{\"host\":\"storage-root\"}]",
                "{path} must not serve the redirected target's contents"
            );
        }
    }

    /// In-place content changes do not move the anchor: a directory recreated
    /// at the same canonical location keeps its root, and only files *under
    /// that root* are served. The contract item that matters — the real
    /// `extensions/state.json` living *outside* every plugin directory —
    /// stays unreachable no matter what a plugin directory contains.
    #[test]
    fn in_place_directory_recreation_keeps_the_anchor() {
        let (root, catalog) = temp_catalog("recreated-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // Recreate the directory in place with fresh content.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::fs::create_dir_all(&plugin_dir).expect("recreate plugin dir");
        std::fs::write(plugin_dir.join("index.js"), b"export default 2;").expect("entry");

        // Same canonical location: the anchor holds, the fresh entry serves.
        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export default 2;");

        // The real extension state file - directly under extensions/, never
        // inside a plugin directory - is still unreachable: no id resolves to
        // it, and no plugin-root containment can cover it.
        let state_path = root
            .join("extensions")
            .join(super::super::discovery::EXTENSION_STATE_FILE);
        let response = serve_extension_asset(
            &catalog,
            &format!(
                "/com.example.plugin/{}",
                state_path.file_name().unwrap().to_string_lossy()
            ),
        );
        // It is not under the plugin root: 403/404, never 200.
        assert_ne!(response.status(), tauri::http::StatusCode::OK);
    }

    /// Regular file updates *inside* the anchored root stay allowed: the
    /// anchor constrains the root, not the files' contents or timestamps.
    #[test]
    fn file_updates_inside_the_anchored_root_are_allowed() {
        let (root, catalog) = temp_catalog("file-update");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // Rewrite the entry module and an asset in place.
        std::fs::write(plugin_dir.join("index.js"), b"export default 42;").expect("rewrite entry");
        std::fs::write(plugin_dir.join("assets").join("app.js"), b"export const x = 3;")
            .expect("rewrite asset");

        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export default 42;");
        let response = serve_extension_asset(&catalog, "/com.example.plugin/assets/app.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export const x = 3;");
    }

    /// The bundle URL is platform-correct and encodes both segments.
    #[test]
    fn bundle_url_is_platform_correct_and_encoded() {
        let (_root, catalog) = temp_catalog("bundle-url");
        let url = bundle_url(&catalog.external[0]);
        if cfg!(windows) {
            assert_eq!(url, "http://plugin.localhost/com.example.plugin/index.js");
        } else {
            assert_eq!(url, "plugin://localhost/com.example.plugin/index.js");
        }

        // Ids and paths needing encoding stay unambiguous.
        let odd = DiscoveredPlugin {
            entry: ExternalExtensionEntry {
                id: "com.example/a b".to_string(),
                display_name: "Odd".to_string(),
                version: "1".to_string(),
                api_version: SUPPORTED_API_VERSION,
                builtin: false,
                default_enabled: true,
                main: "dir name/entry file.js".to_string(),
                contributes: Contributes::default(),
            },
            dir: PathBuf::from("odd"),
            canonical_dir: PathBuf::from("odd"),
        };
        let url = bundle_url(&odd);
        let (origin, rest) = url.split_once("://").expect("origin");
        let host = if cfg!(windows) {
            "plugin.localhost"
        } else {
            "localhost"
        };
        assert_eq!(origin, if cfg!(windows) { "http" } else { "plugin" });
        assert!(rest.starts_with(&format!("{host}/")), "{url}");
        let path = rest.trim_start_matches(&format!("{host}/"));
        assert!(path.starts_with("com.example%2Fa%20b/"), "{url}");
        assert!(path.ends_with("dir%20name/entry%20file.js"), "{url}");
        // And the pieces round-trip through the decoder.
        let (id, main) = path.split_once('/').expect("id/main split");
        assert_eq!(decode_segment(id), "com.example/a b");
        assert_eq!(
            main.split('/').map(decode_segment).collect::<Vec<_>>(),
            vec!["dir name".to_string(), "entry file.js".to_string()]
        );
    }

    /// The scheme name matches the registration and the plan's URL shape.
    #[test]
    fn scheme_name_is_plugin() {
        assert_eq!(PLUGIN_SCHEME, "plugin");
    }
}
