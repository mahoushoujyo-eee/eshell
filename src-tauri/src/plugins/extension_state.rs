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
struct ActivationRow {
    enabled: bool,
}

/// The whole persisted file. `BTreeMap` so the file on disk is deterministic.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFile {
    #[serde(default)]
    extensions: BTreeMap<String, ActivationRow>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "eshell-ext-state-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("create root");
        root
    }

    /// Restart round-trip: a flag saved in one store is loaded by the next.
    #[test]
    fn save_then_load_round_trips_across_restart() {
        let root = temp_root("roundtrip");
        {
            let mut store = ActivationStateStore::load(&root);
            assert!(store.get("com.example.plugin").is_none());
            store
                .save("com.example.plugin", false)
                .expect("save disable");
            store.save("eshell.sftp", true).expect("save enable");
            assert_eq!(store.get("com.example.plugin"), Some(false));
            assert_eq!(store.get("eshell.sftp"), Some(true));
        }
        let reloaded = ActivationStateStore::load(&root);
        assert_eq!(reloaded.get("com.example.plugin"), Some(false));
        assert_eq!(reloaded.get("eshell.sftp"), Some(true));
        assert!(reloaded.get("unknown").is_none());

        let on_disk =
            std::fs::read_to_string(root.join(EXTENSION_STATE_FILE)).expect("read state file");
        let parsed: ActivationFile =
            serde_json::from_str(&on_disk).expect("state file is valid json");
        assert_eq!(parsed.extensions.len(), 2);
        assert!(!parsed.extensions["com.example.plugin"].enabled);
        assert!(parsed.extensions["eshell.sftp"].enabled);
    }

    /// Missing file: clean store. Corrupt file: clean store, no crash.
    #[test]
    fn missing_and_corrupt_files_load_empty() {
        let missing = temp_root("missing");
        let store = ActivationStateStore::load(&missing);
        assert!(store.get("anything").is_none());

        let corrupt = temp_root("corrupt");
        std::fs::write(corrupt.join(EXTENSION_STATE_FILE), "{not json").expect("write corrupt");
        let store = ActivationStateStore::load(&corrupt);
        assert!(store.get("anything").is_none());
    }

    /// A failed write must leave the file and the map untouched: covering a
    /// read-only-ish target (here: `state.json` occupied by a directory, so
    /// both the temp write under it and the rename onto it fail on Windows
    /// and Unix alike) and asserting no rollback fiction.
    #[test]
    fn failed_save_leaves_file_and_map_untouched() {
        let root = temp_root("failed-save");
        {
            let mut store = ActivationStateStore::load(&root);
            store.save("com.example.plugin", false).expect("first save");
        }
        let before =
            std::fs::read_to_string(root.join(EXTENSION_STATE_FILE)).expect("read state");

        // Occupy the state path with a directory: the rename cannot land.
        std::fs::remove_file(root.join(EXTENSION_STATE_FILE)).expect("remove file");
        std::fs::create_dir(root.join(EXTENSION_STATE_FILE)).expect("occupy path");

        let mut store = ActivationStateStore::load(&root);
        // The load sees no file (the path is a directory), so no stale flags.
        assert!(store.get("com.example.plugin").is_none());
        let error = store
            .save("com.example.plugin", true)
            .expect_err("the write must fail");
        assert!(error.contains("cannot"), "{error}");
        // The map is unchanged: the failed flag was not half-committed.
        assert!(store.get("com.example.plugin").is_none());
        assert_eq!(store.keys(), Vec::<String>::new());

        // Cleanup the occupied path and prove the pre-failure file content was
        // preserved by the store that wrote it (round-trip from `before`).
        std::fs::remove_dir(root.join(EXTENSION_STATE_FILE)).expect("remove occupied dir");
        std::fs::write(root.join(EXTENSION_STATE_FILE), &before).expect("restore file");
        let restored = ActivationStateStore::load(&root);
        assert_eq!(restored.get("com.example.plugin"), Some(false));
    }

    /// The temp file must not linger after a successful save.
    #[test]
    fn successful_save_leaves_no_temp_file() {
        let root = temp_root("no-temp");
        let mut store = ActivationStateStore::load(&root);
        store.save("com.example.plugin", true).expect("save");
        assert!(!root.join("state.json.tmp").exists());
        assert!(root.join(EXTENSION_STATE_FILE).exists());
    }
}
