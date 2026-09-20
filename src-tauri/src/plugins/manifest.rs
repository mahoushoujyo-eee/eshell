//! The single built-in extension manifest: `extensions/builtin.json`.
//!
//! This file is the only source of built-in extension metadata. It is shared
//! with the frontend agent through the same bytes (`include_str!` of the
//! committed file), so no duplicate Rust manifest exists. Parsing is strict:
//! a malformed manifest is a startup/test failure, never a silent default.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// `extensions/builtin.json`, verbatim. `include_str!` embeds the shared
/// contract bytes; the file is read again at test time (see [`tests`]) so a
/// drifted embedded copy fails loudly.
const BUILTIN_MANIFEST_JSON: &str = include_str!("../../../extensions/builtin.json");

/// The extension API version this host implements.
///
/// External manifests must declare exactly this version; a mismatched plugin
/// is skipped at discovery instead of loading half-working.
pub const SUPPORTED_API_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinManifest {
    pub manifest_version: i64,
    pub extensions: Vec<BuiltinExtensionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinExtensionEntry {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub api_version: i64,
    pub builtin: bool,
    pub default_enabled: bool,
    pub contributes: Contributes,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default)]
    pub panels: Vec<ContributedPanel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContributedPanel {
    pub id: String,
    pub order: i64,
}

/// One validated external extension manifest entry.
///
/// Produced only by [`super::discovery`]; every field has passed the
/// external validation rules (identity, API version, `builtin: false`,
/// `defaultEnabled: true`, entry-module path and suffix).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalExtensionEntry {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub api_version: i64,
    pub builtin: bool,
    pub default_enabled: bool,
    /// Entry module, relative to the plugin directory. Already defaulted
    /// (`index.js`) and validated (in-directory, `js`/`mjs`, existing file).
    pub main: String,
    pub contributes: Contributes,
}

/// The merged runtime catalog: builtin manifest order followed by the
/// discovered external plugins (deterministic directory order).
///
/// This is what `list_extensions` / `set_extension_enabled` and the
/// `extensions-changed` event render against, so builtin rows keep their
/// pre-external shape and external rows are appended after them.
#[derive(Debug, Clone)]
pub struct ExtensionCatalog {
    pub builtin: BuiltinManifest,
    /// Discovered external plugins in deterministic order.
    pub external: Vec<DiscoveredPlugin>,
}

/// One discovered external plugin: its validated manifest plus the directory
/// it was discovered in (which need not equal its manifest id).
#[derive(Debug, Clone)]
pub struct DiscoveredPlugin {
    pub entry: ExternalExtensionEntry,
    /// The directory as discovered (unresolved path, as walked from
    /// `extensions/`). Resolution goes through the catalog, never by
    /// concatenating an untrusted id into a path.
    pub dir: PathBuf,
    /// The canonical directory *validated at discovery time*. This is the
    /// trusted anchor: every protocol request must resolve inside it, and a
    /// directory that was replaced or re-pointed after discovery (a new
    /// symlink target) is refused instead of being re-anchored.
    pub canonical_dir: PathBuf,
}

impl ExtensionCatalog {
    /// Iterates builtin entries followed by external ones.
    ///
    /// Order is the descriptor order the frontend renders and the
    /// `extensions-changed` event carries.
    pub fn iter_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .builtin
            .extensions
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        ids.extend(self.external.iter().map(|plugin| plugin.entry.id.clone()));
        ids
    }

    /// Finds one external plugin by manifest id.
    pub fn find_external(&self, extension_id: &str) -> Option<&DiscoveredPlugin> {
        self.external
            .iter()
            .find(|plugin| plugin.entry.id == extension_id)
    }
}

impl BuiltinManifest {
    /// Parses the embedded `extensions/builtin.json`.
    ///
    /// Extensions are kept in manifest order; that order is the order
    /// `list_extensions` returns, which the frontend renders.
    pub fn parse() -> Result<Self, String> {
        Self::parse_from_str(BUILTIN_MANIFEST_JSON)
    }

    pub fn parse_from_str(source: &str) -> Result<Self, String> {
        let manifest: BuiltinManifest =
            serde_json::from_str(source).map_err(|error| format!("builtin manifest: {error}"))?;
        if manifest.manifest_version != 1 {
            return Err(format!(
                "builtin manifest: unsupported manifestVersion {}",
                manifest.manifest_version
            ));
        }
        if manifest.extensions.is_empty() {
            return Err("builtin manifest: no extensions declared".to_string());
        }
        let mut seen = std::collections::BTreeSet::new();
        for entry in &manifest.extensions {
            if !seen.insert(entry.id.as_str()) {
                return Err(format!(
                    "builtin manifest: duplicate extension id {}",
                    entry.id
                ));
            }
            if !entry.builtin {
                return Err(format!(
                    "builtin manifest: extension {} is not marked builtin",
                    entry.id
                ));
            }
        }
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded copy must match the file on disk byte for byte, so the
    /// frontend and the backend always read the same contract.
    #[test]
    fn embedded_manifest_matches_the_committed_file() {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir");
        let on_disk = std::fs::read_to_string(
            std::path::Path::new(&manifest_dir)
                .join("..")
                .join("extensions")
                .join("builtin.json"),
        )
        .expect("read manifest");
        assert_eq!(BUILTIN_MANIFEST_JSON, on_disk);
    }

    #[test]
    fn manifest_parses_and_declares_both_extensions_enabled_by_default() {
        let manifest = BuiltinManifest::parse().expect("parse builtin manifest");
        let ids: Vec<&str> = manifest.extensions.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["eshell.sftp", "eshell.server-monitor"]);
        for entry in &manifest.extensions {
            assert!(entry.builtin);
            assert!(entry.default_enabled);
            assert_eq!(entry.api_version, 1);
            assert!(!entry.version.trim().is_empty());
            assert!(
                !entry.contributes.panels.is_empty(),
                "{} must contribute a panel",
                entry.id
            );
        }
    }

    #[test]
    fn malformed_manifests_are_rejected() {
        assert!(BuiltinManifest::parse_from_str("not json").is_err());
        assert!(BuiltinManifest::parse_from_str("{}").is_err());
        // A non-builtin entry or a duplicate id must not parse.
        let duplicate = r#"{
            "manifestVersion": 1,
            "extensions": [
                {"id": "x", "displayName": "X", "version": "1", "apiVersion": 1,
                 "builtin": true, "defaultEnabled": true,
                 "contributes": {"panels": []}},
                {"id": "x", "displayName": "X", "version": "1", "apiVersion": 1,
                 "builtin": true, "defaultEnabled": true,
                 "contributes": {"panels": []}}
            ]
        }"#;
        assert!(BuiltinManifest::parse_from_str(duplicate).is_err());
        let not_builtin = r#"{
            "manifestVersion": 1,
            "extensions": [
                {"id": "x", "displayName": "X", "version": "1", "apiVersion": 1,
                 "builtin": false, "defaultEnabled": true,
                 "contributes": {"panels": []}}
            ]
        }"#;
        assert!(BuiltinManifest::parse_from_str(not_builtin).is_err());
        let bad_version = r#"{
            "manifestVersion": 2,
            "extensions": [
                {"id": "x", "displayName": "X", "version": "1", "apiVersion": 1,
                 "builtin": true, "defaultEnabled": true,
                 "contributes": {"panels": []}}
            ]
        }"#;
        assert!(BuiltinManifest::parse_from_str(bad_version).is_err());
    }

    #[test]
    fn supported_api_version_is_one() {
        assert_eq!(SUPPORTED_API_VERSION, 1);
    }

    /// The catalog concatenates builtin order with external order, and
    /// resolves external ids through the discovered directory map.
    #[test]
    fn catalog_iterates_builtin_then_external_and_finds_by_id() {
        let builtin = BuiltinManifest::parse().expect("manifest");
        let catalog = ExtensionCatalog {
            builtin,
            external: vec![DiscoveredPlugin {
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
                dir: PathBuf::from("somewhere/com.example.plugin"),
                canonical_dir: PathBuf::from("somewhere/com.example.plugin"),
            }],
        };

        assert_eq!(
            catalog.iter_ids(),
            vec![
                "eshell.sftp".to_string(),
                "eshell.server-monitor".to_string(),
                "com.example.plugin".to_string(),
            ]
        );
        assert!(catalog.find_external("eshell.sftp").is_none());
        let found = catalog
            .find_external("com.example.plugin")
            .expect("external id resolves");
        assert_eq!(found.entry.main, "index.js");
        assert!(found.dir.ends_with("com.example.plugin"));
    }
}
