//! The single built-in extension manifest: `extensions/builtin.json`.
//!
//! This file is the only source of built-in extension metadata. It is shared
//! with the frontend agent through the same bytes (`include_str!` of the
//! committed file), so no duplicate Rust manifest exists. Parsing is strict:
//! a malformed manifest is a startup/test failure, never a silent default.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::domain::extensions::consts::*;

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

