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

use super::manifest::{
    Contributes, DiscoveredPlugin, ExternalExtensionEntry, SUPPORTED_API_VERSION,
};

/// The persisted activation state file, `extensions/state.json`.
/// It is a bookkeeping file, not a plugin, and is never discovered or served.
pub const EXTENSION_STATE_FILE: &str = "state.json";
/// Default entry module when a manifest omits `main`.
const DEFAULT_MAIN: &str = "index.js";
/// Default activation when a manifest omits `defaultEnabled`.
const DEFAULT_ENABLED: bool = true;
/// Entry modules must be executable ESM. Asset requests use the wider
/// suffix/MIME allowlist in [`super::protocol`] instead.
const ENTRY_SUFFIXES: [&str; 2] = ["js", "mjs"];

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
    // `AppState::new_with_ops_agent_tools`).
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

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin_ids() -> BTreeSet<String> {
        ["eshell.sftp", "eshell.server-monitor"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "eshell-discovery-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join("extensions")).expect("create extensions root");
        root.join("extensions")
    }

    fn write_plugin(root: &Path, dir: &str, manifest: &str) {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).expect("create plugin dir");
        std::fs::write(dir.join("manifest.json"), manifest).expect("write manifest");
        std::fs::write(dir.join("index.js"), "export default 1;").expect("write entry");
    }

    const VALID: &str = r#"{
        "id": "com.example.plugin",
        "displayName": "Example",
        "version": "1.0.0",
        "apiVersion": 1,
        "builtin": false,
        "defaultEnabled": true,
        "main": "index.js"
    }"#;

    /// A happy plugin is accepted with its directory resolved and defaults
    /// (`contributes` empty, `main` as declared).
    #[test]
    fn accepts_a_valid_plugin() {
        let root = temp_root("valid");
        write_plugin(&root, "com.example.plugin", VALID);
        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(plugins.len(), 1);
        let plugin = &plugins[0];
        assert_eq!(plugin.entry.id, "com.example.plugin");
        assert!(!plugin.entry.builtin);
        assert!(plugin.entry.default_enabled);
        assert_eq!(plugin.entry.main, "index.js");
        assert!(plugin.entry.contributes.panels.is_empty());
        assert!(plugin.dir.ends_with("com.example.plugin"));
    }

    /// `main` is optional and defaults to `index.js`.
    #[test]
    fn main_defaults_to_index_js() {
        let root = temp_root("default-main");
        let manifest = r#"{
            "id": "com.example.no-main", "displayName": "X", "version": "1",
            "apiVersion": 1, "builtin": false, "defaultEnabled": true
        }"#;
        write_plugin(&root, "no-main", manifest);
        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(plugins[0].entry.main, "index.js");
    }

    /// Broken manifests are skipped with a reason; other plugins survive.
    /// Covers: bad JSON, missing manifest, apiVersion mismatch, builtin:true,
    /// empty id, missing displayName.
    #[test]
    fn invalid_manifests_are_isolated_and_skipped() {
        let root = temp_root("invalid");
        write_plugin(&root, "a-good", &VALID.replace("com.example.plugin", "com.example.good"));

        let bad_json = root.join("bad-json");
        std::fs::create_dir_all(&bad_json).expect("mkdir");
        std::fs::write(bad_json.join("manifest.json"), "{not json").expect("write");

        let no_manifest = root.join("no-manifest");
        std::fs::create_dir_all(&no_manifest).expect("mkdir");

        // Each manifest is complete on its own; the mutated field is what
        // the rule under test should reject.
        let cases: Vec<(&str, String)> = vec![
            (
                "api-mismatch",
                case_manifest(r#""com.example.case""#, r#""Case""#, "2", "false", "true"),
            ),
            (
                "builtin-true",
                case_manifest(r#""com.example.case""#, r#""Case""#, "1", "true", "true"),
            ),
            (
                "empty-id",
                case_manifest(r#""""#, r#""Case""#, "1", "false", "true"),
            ),
            (
                "empty-name",
                case_manifest(r#""com.example.case""#, r#""""#, "1", "false", "true"),
            ),
        ];
        for (name, manifest) in &cases {
            write_plugin(&root, name, manifest);
        }

        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert_eq!(plugins.len(), 1, "only the good plugin survives");
        assert_eq!(plugins[0].entry.id, "com.example.good");
        assert_eq!(problems.len(), 6, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("bad-json")));
        assert!(problems.iter().any(|p| p.contains("no-manifest")));
        assert!(problems.iter().any(|p| p.contains("apiVersion 2")));
        assert!(problems
            .iter()
            .any(|p| p.contains("must declare builtin: false")));
        assert!(problems.iter().any(|p| p.contains("id must not be empty")));
    }

    /// `defaultEnabled` is optional: a manifest that omits it defaults to
    /// `true`; an explicit `false` is legal and flows through verbatim.
    #[test]
    fn default_enabled_is_optional_and_flows_through() {
        let root = temp_root("default-enabled");

        // Missing `defaultEnabled` -> true.
        let omitted = r#"{
            "id": "com.example.omitted",
            "displayName": "Omitted",
            "version": "1.0.0",
            "apiVersion": 1,
            "builtin": false,
            "main": "index.js"
        }"#;
        write_plugin(&root, "omitted", omitted);

        // Explicit `false` -> still discovered, disabled by default.
        let explicit = r#"{
            "id": "com.example.explicit",
            "displayName": "Explicit",
            "version": "1.0.0",
            "apiVersion": 1,
            "builtin": false,
            "defaultEnabled": false,
            "main": "index.js"
        }"#;
        write_plugin(&root, "explicit", explicit);

        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(plugins.len(), 2, "both must be discovered");
        let by_id = |id: &str| {
            plugins
                .iter()
                .find(|p| p.entry.id == id)
                .unwrap_or_else(|| panic!("missing {id}"))
        };
        assert!(by_id("com.example.omitted").entry.default_enabled);
        assert!(!by_id("com.example.explicit").entry.default_enabled);
    }

    /// Ids are validated as URL-segment identifiers: whitespace-padded,
    /// `.`, `..`, separator-bearing and control-character ids are rejected —
    /// never trimmed or renamed — while reverse-domain and Unicode ids pass.
    #[test]
    fn id_rules_reject_unstable_identifiers() {
        let root = temp_root("id-rules");
        let bad: Vec<(&str, String)> = vec![
            ("padded", r#"{"id": " com.example.padded ", "displayName": "P", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#.to_string()),
            ("dot", r#"{"id": ".", "displayName": "D", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#.to_string()),
            ("dotdot", r#"{"id": "..", "displayName": "D", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#.to_string()),
            ("slash", r#"{"id": "com/example", "displayName": "S", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#.to_string()),
            ("control", r#"{"id": "com.example\u0001", "displayName": "C", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#.to_string()),
        ];
        for (name, manifest) in &bad {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).expect("mkdir");
            std::fs::write(dir.join("manifest.json"), manifest).expect("write manifest");
            std::fs::write(dir.join("index.js"), "export default 1;").expect("write entry");
        }

        // A well-formed id with a dot inside (reverse domain) still passes,
        // and so does a Unicode id: neither is a reserved segment.
        write_plugin(&root, "a-good", &VALID.replace("com.example.plugin", "com.example.good"));
        let unicode = r#"{"id": "插件.示例", "displayName": "U", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#;
        write_plugin(&root, "b-unicode", &VALID.replace("com.example.plugin", "插件.示例"));
        std::fs::write(root.join("b-unicode").join("manifest.json"), unicode).expect("write unicode manifest");

        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert_eq!(problems.len(), 5, "{problems:?}");
        assert!(plugins
            .iter()
            .any(|p| p.entry.id == "com.example.good"));
        assert!(plugins.iter().any(|p| p.entry.id == "插件.示例"));
        assert!(problems.iter().any(|p| p.contains("whitespace")));
        assert!(problems
            .iter()
            .any(|p| p.contains("reserved path segment")));
        assert!(problems.iter().any(|p| p.contains("path separator")));
        assert!(problems
            .iter()
            .any(|p| p.contains("control characters")));
    }

    /// A whitespace-padded id is rejected instead of being treated as an alias
    /// of its trimmed form: with `foo` already accepted, `" foo "` must not
    /// silently collide with it (or be discoverable under either name).
    #[test]
    fn padded_id_is_rejected_not_aliased_to_its_trimmed_form() {
        let root = temp_root("trim-alias");
        // `foo` wins its directory (sorted first).
        write_plugin(&root, "a-foo", &VALID.replace("com.example.plugin", "foo"));
        // `" foo "` would be `foo` after the frontend's normalization; the
        // backend must refuse it rather than register a second `foo` alias.
        let padded = r#"{"id": " foo ", "displayName": "F", "version": "1", "apiVersion": 1, "builtin": false, "main": "index.js"}"#;
        write_plugin(&root, "b-padded", padded);

        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert_eq!(plugins.len(), 1, "{problems:?}");
        assert_eq!(plugins[0].entry.id, "foo");
        // The padded id was rejected on its own merits — and crucially, it
        // was NOT accepted under either its raw or its trimmed form.
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("whitespace"), "{problems:?}");
        assert!(
            !plugins.iter().any(|p| p.entry.id == " foo "),
            "the raw padded id must not be registered"
        );
        assert!(
            plugins.iter().filter(|p| p.entry.id == "foo").count() == 1,
            "exactly one foo, no silent alias"
        );
    }

    /// A `defaultEnabled: false` plugin is listed (so the user can enable it),
    /// starts disabled, and a persisted `true` overrides the manifest default
    /// across a restart.
    #[test]
    fn default_disabled_plugin_is_listed_and_overridable() {
        let root = std::env::temp_dir().join(format!(
            "eshell-discovery-default-disabled-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = root.join("extensions").join("a-plugin");
        std::fs::create_dir_all(&plugin_dir).expect("mkdir");
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{
                "id": "com.example.off-by-default",
                "displayName": "Off",
                "version": "1.0.0",
                "apiVersion": 1,
                "builtin": false,
                "defaultEnabled": false
            }"#,
        )
        .expect("write manifest");
        std::fs::write(plugin_dir.join("index.js"), "export default 1;").expect("write entry");

        // Run one: the plugin is in the catalog, disabled.
        let state = crate::state::AppState::new(root.clone()).expect("state one");
        let catalog = state.extensions_catalog();
        assert_eq!(catalog.external.len(), 1);
        assert_eq!(catalog.external[0].entry.id, "com.example.off-by-default");
        assert!(!catalog.external[0].entry.default_enabled);
        assert!(
            !state.extensions().is_enabled("com.example.off-by-default"),
            "a defaultEnabled:false plugin starts disabled"
        );
        // `list_extensions` still lists it, so the user can enable it.
        let rows = state.extensions().descriptors(&state.extensions_catalog());
        let row = rows
            .iter()
            .find(|row| row.id == "com.example.off-by-default")
            .expect("the disabled plugin must be listed");
        assert!(!row.enabled);
        assert!(!row.default_enabled);

        // Enable through the production transaction: persisted `true`.
        state
            .extensions()
            .apply_enabled_with_persist(
                "com.example.off-by-default",
                true,
                &state.extensions_catalog(),
                || {
                    state.persist_extension_enabled("com.example.off-by-default", true)
                },
                |_| {},
            )
            .expect("enable");

        // Run two (restart): the persisted `true` overrides the manifest's
        // `false` and survives.
        let restarted = crate::state::AppState::new(root.clone()).expect("state two");
        assert!(
            restarted
                .extensions()
                .is_enabled("com.example.off-by-default"),
            "a persisted enable must override defaultEnabled:false across a restart"
        );
        let rows = restarted
            .extensions()
            .descriptors(&restarted.extensions_catalog());
        let row = rows
            .iter()
            .find(|row| row.id == "com.example.off-by-default")
            .expect("row");
        assert!(row.enabled);
        assert!(!row.default_enabled, "the manifest default stays recorded");
    }

    /// A complete manifest, every field explicit. No duplicate keys, so each
    /// rejection comes from the rule under test, never serde's
    /// duplicate-field error.
    #[allow(clippy::too_many_arguments)]
    fn case_manifest(
        id: &str,
        display_name: &str,
        api_version: &str,
        builtin: &str,
        default_enabled: &str,
    ) -> String {
        format!(
            r#"{{
                "id": {id},
                "displayName": {display_name},
                "version": "1.0.0",
                "apiVersion": {api_version},
                "builtin": {builtin},
                "defaultEnabled": {default_enabled},
                "main": "index.js"
            }}"#
        )
    }

    /// Duplicate ids: the first directory in sorted order wins, the later one
    /// is skipped deterministically, builtin ids are never shadowed.
    #[test]
    fn duplicate_and_builtin_ids_are_skipped_stably() {
        let root = temp_root("duplicates");
        let manifest = VALID.replace("com.example.plugin", "com.example.dup");
        write_plugin(&root, "a-first", &manifest);
        write_plugin(&root, "b-second", &manifest);
        write_plugin(&root, "c-builtin", &VALID.replace("com.example.plugin", "eshell.sftp"));

        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert_eq!(plugins.len(), 1, "{problems:?}");
        assert_eq!(plugins[0].entry.id, "com.example.dup");
        assert!(plugins[0].dir.ends_with("a-first"), "sorted order decides");
        assert_eq!(problems.len(), 2);
        assert!(problems
            .iter()
            .any(|p| p.contains("duplicate extension id com.example.dup")));
        assert!(problems
            .iter()
            .any(|p| p.contains("duplicate extension id eshell.sftp")));
    }

    /// The entry module cannot escape: `..`, absolute paths, backslashes and
    /// a symlink pointing outside the plugin directory are all rejected.
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn entry_module_escapes_are_rejected() {
        let root = temp_root("escape");
        let outside = root.parent().unwrap().join("outside-target.js");
        std::fs::write(&outside, "export default 1;").expect("write outside target");

        let cases: Vec<(&str, &str)> = vec![
            ("parent", r#""main": "../index.js""#),
            ("absolute", r#""main": "/etc/passwd""#),
            ("backslash", r#""main": "..\\index.js""#),
        ];
        for (name, main_field) in &cases {
            write_plugin(
                &root,
                name,
                &format!(
                    r#"{{
                        "id": "com.example.{name}", "displayName": "X", "version": "1",
                        "apiVersion": 1, "builtin": false, "defaultEnabled": true,
                        {main_field}
                    }}"#
                ),
            );
        }

        // A plugin whose entry module is a symlink to a file outside its dir.
        let symlink_dir = root.join("s-link");
        std::fs::create_dir_all(&symlink_dir).expect("mkdir");
        std::fs::write(
            symlink_dir.join("manifest.json"),
            VALID.replace("com.example.plugin", "com.example.link"),
        )
        .expect("write manifest");
        std::os::unix::fs::symlink(&outside, symlink_dir.join("index.js")).expect("symlink");

        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert!(plugins.is_empty(), "every escape must be rejected");
        assert_eq!(problems.len(), 4, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("escape")));
        assert!(problems.iter().any(|p| p.contains("relative path")));
        assert!(problems.iter().any(|p| p.contains("separators")));
        assert!(problems
            .iter()
            .any(|p| p.contains("resolves outside the plugin directory")));
    }

    /// Entry modules must be js/mjs; other suffixes (html, exe, json) reject.
    #[test]
    fn entry_module_suffixes_are_restricted_to_js_and_mjs() {
        let root = temp_root("suffixes");
        for name in ["html", "exe", "json", "mjs"] {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).expect("mkdir");
            // Each manifest declares its own entry module, so the only
            // variable is the suffix.
            std::fs::write(
                dir.join("manifest.json"),
                VALID.replace("com.example.plugin", &format!("com.example.{name}"))
                    .replace("\"main\": \"index.js\"", &format!("\"main\": \"index.{name}\"")),
            )
            .expect("write manifest");
            let entry = dir.join(format!("index.{name}"));
            std::fs::write(&entry, "x").expect("write entry");
        }
        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert_eq!(plugins.len(), 1, "only mjs is an executable entry: {problems:?}");
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(problems
            .iter()
            .all(|p| p.contains("js or mjs entry module")));
    }

    /// A missing entry file rejects the plugin instead of loading air.
    #[test]
    fn missing_entry_file_rejects_the_plugin() {
        let root = temp_root("missing-entry");
        let dir = root.join("no-entry");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("manifest.json"), VALID).expect("write manifest");
        let (plugins, problems) = discover_external_plugins(&root, &builtin_ids());
        assert!(plugins.is_empty());
        assert!(problems
            .iter()
            .any(|p| p.contains("does not resolve") || p.contains("js or mjs")));
    }

    /// A missing extensions/ directory is a clean install, not an error.
    #[test]
    fn missing_extensions_root_is_clean() {
        let root = std::env::temp_dir().join(format!(
            "eshell-discovery-absent-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let (plugins, problems) = discover_external_plugins(&root.join("extensions"), &builtin_ids());
        assert!(plugins.is_empty());
        assert!(problems.is_empty());
    }

    /// Directories are walked in sorted order regardless of the filesystem's
    /// internal ordering, so the catalog is stable across runs.
    #[test]
    fn discovery_is_deterministic_across_runs() {
        let root = temp_root("deterministic");
        for name in ["zeta", "alpha", "mid"] {
            write_plugin(&root, name, &VALID.replace("com.example.plugin", "com.example.any"));
        }
        let first = discover_external_plugins(&root, &builtin_ids());
        let second = discover_external_plugins(&root, &builtin_ids());
        let order = |run: &Vec<DiscoveredPlugin>| {
            run.iter()
                .map(|p| p.dir.file_name().unwrap().to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        // One id across three directories: only the first (sorted) wins, and
        // the duplicate rejections are deterministic too.
        assert_eq!(order(&first.0), ["alpha"]);
        assert_eq!(order(&first.0), order(&second.0));
        assert_eq!(first.1, second.1);
        assert_eq!(first.1.len(), 2, "{:?}", first.1);

        // Distinct ids keep full sorted order.
        let root2 = temp_root("deterministic-ids");
        for name in ["zeta", "alpha", "mid"] {
            write_plugin(&root2, name, &VALID.replace("com.example.plugin", "com.example.any"));
        }
        // Rename the manifest ids to be unique per directory.
        for (name, id) in [("zeta", "com.example.z"), ("alpha", "com.example.a"), ("mid", "com.example.m")] {
            let dir = root2.join(name);
            std::fs::write(
                dir.join("manifest.json"),
                VALID.replace("com.example.plugin", id),
            )
            .expect("rewrite manifest");
        }
        let third = discover_external_plugins(&root2, &builtin_ids());
        assert_eq!(order(&third.0), ["alpha", "mid", "zeta"]);
        assert!(third.1.is_empty(), "{:?}", third.1);
    }
}
