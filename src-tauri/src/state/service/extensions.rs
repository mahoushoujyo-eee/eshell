//! Extension-runtime accessors on `AppState`: the activation registry, the
//! merged catalog snapshot, persisted activation flags and the catalog build.

use crate::common::error::{AppError, AppResult};
use crate::domain::extensions::model_manifest::ExtensionCatalog;
use crate::domain::extensions::service::registry::ExtensionRegistry;
use crate::state::model::AppState;

impl AppState {
    /// The extension registry (activation flags and busy leases).
    pub fn extensions(&self) -> &ExtensionRegistry {
        &self.extensions
    }

    /// The merged builtin + external catalog, for descriptor rendering and
    /// the `plugin` URI scheme.
    ///
    /// Returns a snapshot clone: the catalog is replaced wholesale when a
    /// plugin is installed or removed, so handing out a reference would mean
    /// holding the lock across the caller's whole operation.
    pub fn extensions_catalog(&self) -> ExtensionCatalog {
        self.extensions_catalog
            .read()
            .expect("extension catalog lock poisoned")
            .clone()
    }

    /// Re-scans `extensions/` and swaps in a fresh catalog, returning it.
    ///
    /// Used after an install or a removal. The registry is reconciled with
    /// the new catalog in the same call so a newly discovered plugin has an
    /// activation entry (at its `defaultEnabled`) before anything can ask
    /// whether it is enabled.
    ///
    /// A plugin that is currently busy is left alone: removing its directory
    /// while one of its operations is in flight would strand that operation,
    /// so the id keeps its old entry until the lease is released.
    pub fn rescan_extensions_catalog(&self) -> AppResult<ExtensionCatalog> {
        let catalog = build_extension_catalog(&self.storage.data_dir())?;
        self.extensions.reconcile_catalog(&catalog);
        *self
            .extensions_catalog
            .write()
            .expect("extension catalog lock poisoned") = catalog.clone();
        Ok(catalog)
    }

    /// Persists one explicit activation flag to `extensions/state.json`.
    ///
    /// Called from inside the registry's lifecycle critical section (see
    /// [`ExtensionRegistry::apply_enabled_with_persist`]); a failure rejects
    /// the whole transition, so this returns `Err` without touching the
    /// in-memory map.
    pub fn persist_extension_enabled(
        &self,
        extension_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        self.extension_activation
            .lock()
            .expect("extension activation lock poisoned")
            .save(extension_id, enabled)
    }

    /// Drops one extension's persisted activation flag.
    ///
    /// Called on uninstall so a later reinstall of the same id starts from
    /// its manifest `defaultEnabled` rather than the removed copy's choice.
    /// A failure to persist is not fatal to the uninstall: the directory is
    /// already gone, and a stale flag for an absent id is inert.
    pub fn forget_extension_enabled(&self, extension_id: &str) {
        let _ = self
            .extension_activation
            .lock()
            .expect("extension activation lock poisoned")
            .remove(extension_id);
    }

    /// The persisted flag for one extension, if it was ever toggled.
    #[cfg(test)]
    pub fn persisted_extension_enabled(&self, extension_id: &str) -> Option<bool> {
        self.extension_activation
            .lock()
            .expect("extension activation lock poisoned")
            .get(extension_id)
    }

    /// Test-only: registers one external extension id into the activation
    /// surface so broker tests can take a caller lease on it.
    ///
    /// Real registration happens in [`AppState::new`] via discovery; tests that
    /// did not install a plugin directory use this.
    #[cfg(test)]
    pub fn extensions_test_register(&self, extension_id: &str) {
        self.extensions.test_register(extension_id);
    }
}

/// Builds the merged extension catalog for one storage root.
///
/// The builtin manifest is strict (a broken `builtin.json` is a startup
/// failure). External discovery is best-effort: per-plugin failures are
/// logged to stderr and skipped, never fatal, so one broken user-installed
/// plugin cannot block startup or hide its neighbors.
pub(crate) fn build_extension_catalog(
    storage_root: &std::path::Path,
) -> AppResult<ExtensionCatalog> {
    let builtin = crate::domain::extensions::model_manifest::BuiltinManifest::parse()
        .map_err(AppError::Runtime)?;
    let builtin_ids: std::collections::BTreeSet<String> =
        builtin.extensions.iter().map(|e| e.id.clone()).collect();
    let extensions_dir = storage_root.join("extensions");
    // A missing directory is a clean install; create it so a later toggle can
    // persist without a surprise. Failure is ignored: discovery treats a
    // missing directory as "no external plugins".
    let _ = std::fs::create_dir_all(&extensions_dir);
    let (external, problems) =
        crate::domain::extensions::service::discovery::discover_external_plugins(
            &extensions_dir,
            &builtin_ids,
        );
    for problem in &problems {
        eprintln!("eshell: skipping external plugin: {problem}");
    }
    Ok(ExtensionCatalog { builtin, external })
}
