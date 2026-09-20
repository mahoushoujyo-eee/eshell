//! External plugin discovery: scan, validate, isolate failures per plugin.
//!
//! Scans the immediate child directories of `<storage root>/extensions/` for
//! `manifest.json`. A plugin directory need not equal its manifest id; the
//! resolved catalog maps id -> directory, so no untrusted id is ever
//! concatenated into a filesystem path.
//!
//! Validation happens here, once, at startup:
//! - identity: nonempty id, no path separators, unique against builtin and
//!   already-accepted external ids (duplicates are skipped deterministically:
//!   directory order decides, later ones lose);
//! - `apiVersion` must equal [`SUPPORTED_API_VERSION`];
//! - `builtin` must be `false` (an external manifest claiming builtin is
//!   rejected, so it cannot pose as a builtin plugin);
//! - `defaultEnabled` is optional and defaults to `true`; an explicit `false`
//!   is legal: the plugin is still discovered and listed (so the user can
//!   enable it), it just starts disabled;
//! - `main` defaults to `index.js`, must be a relative in-directory path
//!   (`..`/absolute/backslash rejected), must exist, must canonically stay
//!   inside the plugin directory (symlinks included), and must be an
//!   executable ESM suffix (`js`/`mjs`).
//!
//! A missing `extensions/` directory is not an error: a clean install simply
//! has no external plugins. Any per-plugin failure is logged and skipped;
//! discovery never fails startup and never lets one broken plugin hide another.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use crate::domain::extensions::consts::*;
use crate::domain::extensions::model_manifest::{
    Contributes, DiscoveredPlugin, ExternalExtensionEntry,
};

/// The persisted activation state file: re-exported here because the
/// activation store and the protocol tests reach it through this module.
pub use crate::domain::extensions::consts::EXTENSION_STATE_FILE;

/// The raw on-disk manifest shape. Every field is required here except
/// `defaultEnabled` (defaults to `true`), `main` and `contributes`; semantic
/// validation happens after parsing.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExternalManifest {
    id: String,
    display_name: String,
    version: String,
    api_version: i64,
    builtin: bool,
    #[serde(default = "default_enabled_true")]
    default_enabled: bool,
    main: Option<String>,
    contributes: Option<Contributes>,
}

/// serde default for [`RawExternalManifest::default_enabled`].
fn default_enabled_true() -> bool {
    DEFAULT_ENABLED
}

/// One plugin's discovery outcome.
#[derive(Debug)]
enum Outcome {
    Accepted(DiscoveredPlugin),
    /// The plugin was rejected; the message is logged once per plugin.
    Rejected(String),
}

/// Scans `extensions_root` (the `extensions/` directory itself) and returns
/// the accepted plugins in deterministic directory order, plus one log line
/// per rejected directory.
///
/// Determinism: directories are walked in sorted order, so the same tree
/// always yields the same catalog and the same duplicate-id winner.
pub fn discover_external_plugins(
    extensions_root: &Path,
    builtin_ids: &BTreeSet<String>,
) -> (Vec<DiscoveredPlugin>, Vec<String>) {
    let mut plugins = Vec::new();
    let mut problems = Vec::new();
    let Some(children) = read_sorted_child_dirs(extensions_root) else {
        return (plugins, problems);
    };

    let mut seen_ids: BTreeSet<String> = builtin_ids.clone();
    for dir in children {
        // `state.json` under extensions/ is never a plugin directory; it is
        // filtered here by construction (only directories are walked), but the
        // rule is stated where it is enforced: the state file is not a plugin.
        match validate_one(&dir, &seen_ids) {
            Outcome::Accepted(plugin) => {
                seen_ids.insert(plugin.entry.id.clone());
                plugins.push(plugin);
            }
            Outcome::Rejected(reason) => {
                let label = dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("<unnamed>")
                    .to_string();
                problems.push(format!("extensions/{label}: {reason}"));
            }
        }
    }
    (plugins, problems)
}

/// Reads the immediate child directories of `extensions_root`, sorted.
///
/// `None` means the directory does not exist (a clean install): not an error.
/// Unreadable individual entries are skipped, not fatal.
///
/// Note on links: `DirEntry::file_type` does *not* follow symlinks, so a
/// symlink to a directory is not collected here — only real directories are
/// discovered. The canonical containment checks in `validate_entry_module`
/// still guard the entry module against in-directory symlink escapes.
fn read_sorted_child_dirs(extensions_root: &Path) -> Option<Vec<PathBuf>> {
    let entries = std::fs::read_dir(extensions_root).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        // Real directories only (see the module note on links above).
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Some(dirs)
}

/// Reads just the manifest id, without validating anything else.
///
/// The install path needs the id before validation so it can exclude the
/// plugin being replaced from the duplicate-id check — a replace would
/// otherwise collide with the copy it is replacing.
pub fn peek_manifest_id(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let parsed: RawExternalManifest = serde_json::from_str(&raw).ok()?;
    Some(parsed.id)
}

/// Validates one candidate directory against the same rules a startup scan
/// applies, for the install path.
///
/// Returns the manifest entry on success, or the rejection reason. The
/// rejection text is the same one discovery logs, so an install failure and a
/// skipped-at-startup plugin explain themselves identically.
pub fn validate_plugin_dir(
    dir: &Path,
    seen_ids: &BTreeSet<String>,
) -> Result<ExternalExtensionEntry, String> {
    match validate_one(dir, seen_ids) {
        Outcome::Accepted(plugin) => Ok(plugin.entry),
        Outcome::Rejected(reason) => Err(reason),
    }
}

/// Validates one plugin directory and produces its catalog entry.
fn validate_one(dir: &Path, seen_ids: &BTreeSet<String>) -> Outcome {
    let manifest_path = dir.join("manifest.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(error) => {
            return Outcome::Rejected(format!("cannot read manifest.json: {error}"));
        }
    };
    let raw: RawExternalManifest = match serde_json::from_str(&raw) {
        Ok(raw) => raw,
        Err(error) => {
            return Outcome::Rejected(format!("manifest.json is invalid: {error}"));
        }
    };

    // Identity rules, evaluated on the raw id — never trimmed or renamed
    // silently: the id is a URL segment and the broker's caller key, so a
    // value that only differs by surrounding whitespace would collide with a
    // distinct id after the frontend's normalization.
    if raw.id.is_empty() {
        return Outcome::Rejected("id must not be empty".to_string());
    }
    if raw.id != raw.id.trim() {
        return Outcome::Rejected(format!(
            "id {:?} has leading or trailing whitespace; ids are stored verbatim, not trimmed",
            raw.id
        ));
    }
    if raw.id == "." || raw.id == ".." {
        return Outcome::Rejected(format!("id {:?} is a reserved path segment", raw.id));
    }
    if raw.id.contains('/') || raw.id.contains('\\') {
        return Outcome::Rejected(format!("id {:?} contains a path separator", raw.id));
    }
    if raw.id.chars().any(char::is_control) {
        return Outcome::Rejected(format!("id {:?} contains control characters", raw.id));
    }
    if seen_ids.contains(&raw.id) {
        return Outcome::Rejected(format!(
            "duplicate extension id {} (an earlier directory already claimed it)",
            raw.id
        ));
    }
    if raw.api_version != SUPPORTED_API_VERSION {
        return Outcome::Rejected(format!(
            "apiVersion {} is unsupported (this host implements {SUPPORTED_API_VERSION})",
            raw.api_version
        ));
    }
    if raw.builtin {
        return Outcome::Rejected(
            "an external manifest must declare builtin: false".to_string(),
        );
    }
    if raw.display_name.trim().is_empty() || raw.version.trim().is_empty() {
        return Outcome::Rejected("displayName and version must not be empty".to_string());
    }

    let main = raw.main.unwrap_or_else(|| DEFAULT_MAIN.to_string());
    let (main_path, canonical_dir) = match validate_entry_module(dir, &main) {
        Ok(paths) => paths,
        Err(reason) => return Outcome::Rejected(reason),
    };
    let _ = main_path;

    // `defaultEnabled` flows through verbatim: an explicit `false` is a legal
    // disabled-by-default plugin. It is still discovered and listed so the
    // user can enable it; a persisted `true` overrides it (see
    // `AppState::new`).
    Outcome::Accepted(DiscoveredPlugin {
        entry: ExternalExtensionEntry {
            id: raw.id,
            display_name: raw.display_name,
            version: raw.version,
            api_version: SUPPORTED_API_VERSION,
            builtin: false,
            default_enabled: raw.default_enabled,
            main,
            contributes: raw.contributes.unwrap_or_default(),
        },
        dir: dir.to_path_buf(),
        canonical_dir,
    })
}

/// Validates the entry module: relative, in-directory (canonical, symlink
/// aware), existing, `js`/`mjs`.
///
/// Returns the canonical entry path and the canonical plugin directory. The
/// directory is the *trusted anchor* stored on [`DiscoveredPlugin`]: a
/// directory replaced or re-pointed after discovery is refused by the
/// protocol handler instead of re-anchoring the new location.
fn validate_entry_module(dir: &Path, main: &str) -> Result<(PathBuf, PathBuf), String> {
    if main.is_empty() {
        return Err("main must not be empty".to_string());
    }
    if main.contains('\\') {
        return Err(format!("main {main:?} must use '/' separators"));
    }
    let rel = Path::new(main);
    if rel.is_absolute() {
        return Err(format!("main {main:?} must be a relative path"));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("main {main:?} must not escape the plugin directory"));
            }
            _ => return Err(format!("main {main:?} contains an unsupported component")),
        }
    }
    let suffix_ok = rel
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ENTRY_SUFFIXES.contains(&ext.to_ascii_lowercase().as_str()));
    if !suffix_ok {
        return Err(format!(
            "main {main:?} must be a js or mjs entry module"
        ));
    }

    let canonical_dir = canonicalize(dir).map_err(|error| {
        format!("cannot resolve the plugin directory {}: {error}", dir.display())
    })?;
    let entry = dir.join(rel);
    let canonical_entry = canonicalize(&entry).map_err(|error| {
        format!("entry module {} does not resolve: {error}", entry.display())
    })?;
    if !canonical_entry.starts_with(&canonical_dir) {
        return Err(format!(
            "entry module {} resolves outside the plugin directory",
            entry.display()
        ));
    }
    if !canonical_entry.is_file() {
        return Err(format!("entry module {} is not a regular file", entry.display()));
    }
    Ok((canonical_entry, canonical_dir))
}

fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    // `fs::canonicalize` keeps Windows \\?\ prefixes; `dunce` is not a
    // dependency, so the prefix is stripped for comparisons by using the same
    // function on both sides. Comparing two canonicalize outputs is exact.
    std::fs::canonicalize(path)
}

