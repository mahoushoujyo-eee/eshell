//! Persisted extension activation state: `extensions/state.json`.
//!
//! Shape: `{ "<extensionId>": { "enabled": <bool> }, ... }` — one row per
//! extension that was ever explicitly toggled, builtin or external. Loading
//! is best-effort: a missing/corrupt file means "no persisted state", never a
//! failed startup. Saving is transactional from the caller's point of view:
//! [`ActivationStateStore::save`] either replaces the file or returns an
//! error, and the in-memory map is only advanced after the disk write
//! succeeded, so a rejected write cannot half-commit a flag, an event or the
//! registry's generation bump (see [`super::registry`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::discovery::EXTENSION_STATE_FILE;

/// One persisted activation row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationRow {
    pub(crate) enabled: bool,
}

/// The whole persisted file. `BTreeMap` so the file on disk is deterministic.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationFile {
    #[serde(default)]
    pub(crate) extensions: BTreeMap<String, ActivationRow>,
}

/// Best-effort persistence of explicit activation flags.
///
/// The in-memory map mirrors the last successfully written file; reads never
/// touch the disk after construction.
pub struct ActivationStateStore {
    path: PathBuf,
    state: BTreeMap<String, bool>,
}

impl ActivationStateStore {
    /// Loads `extensions/state.json`. Missing/corrupt file: empty state.
    /// The file is *not* rewritten here; only an accepted toggle writes.
    pub fn load(extensions_root: &Path) -> Self {
        let path = extensions_root.join(EXTENSION_STATE_FILE);
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<ActivationFile>(&text).ok())
            .map(|file| {
                file.extensions
                    .into_iter()
                    .map(|(id, row)| (id, row.enabled))
                    .collect()
            })
            .unwrap_or_default();
        Self { path, state }
    }

    /// The persisted flag for one extension, if it was ever toggled.
    ///
    /// Unknown ids (a plugin removed since the last run, or a stale key)
    /// simply return `None`; they are ignored, not an error.
    pub fn get(&self, extension_id: &str) -> Option<bool> {
        self.state.get(extension_id).copied()
    }

    /// The ids this store has a persisted flag for.
    #[cfg(test)]
    pub fn keys(&self) -> Vec<String> {
        self.state.keys().cloned().collect()
    }

    /// Drops one extension's persisted flag.
    ///
    /// Used on uninstall: a later reinstall of the same id must start from
    /// its manifest `defaultEnabled`, not the removed copy's choice. An id
    /// with no flag is a no-op (nothing to write).
    pub fn remove(&mut self, extension_id: &str) -> Result<(), String> {
        if !self.state.contains_key(extension_id) {
            return Ok(());
        }
        let mut next = self.state.clone();
        next.remove(extension_id);
        let file = ActivationFile {
            extensions: next
                .iter()
                .map(|(id, enabled)| (id.clone(), ActivationRow { enabled: *enabled }))
                .collect(),
        };
        let text = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, text)
            .map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
        std::fs::rename(&temp, &self.path).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            format!("cannot update {}: {error}", self.path.display())
        })?;
        self.state = next;
        Ok(())
    }

    /// Persists the full map with one new explicit flag.
    ///
    /// On success the in-memory map is advanced to match the file. On failure
    /// nothing changes: not the file, not the map — the caller must reject
    /// the whole transition (no flag update, no event, no cleanup).
    ///
    /// The write is temp-file + rename so a crash never leaves a truncated
    /// state file behind.
    pub fn save(&mut self, extension_id: &str, enabled: bool) -> Result<(), String> {
        let mut next = self.state.clone();
        next.insert(extension_id.to_string(), enabled);
        let file = ActivationFile {
            extensions: next
                .iter()
                .map(|(id, enabled)| (id.clone(), ActivationRow { enabled: *enabled }))
                .collect(),
        };
        let text = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, text).map_err(|error| {
            format!(
                "cannot write {}: {error}",
                temp.display()
            )
        })?;
        std::fs::rename(&temp, &self.path).map_err(|error| {
            // Best-effort cleanup of the temp file; the real file is untouched.
            let _ = std::fs::remove_file(&temp);
            format!(
                "cannot activate {}: {error}",
                self.path.display()
            )
        })?;
        self.state = next;
        Ok(())
    }
}

