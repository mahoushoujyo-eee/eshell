//! Activation registry and busy leases for built-in extensions.
//!
//! Locking: one `std::sync::Mutex` guards the entries map *and* the busy
//! counters together. Every operation that reads or changes activation —
//! `is_enabled`, `lease`, `set_enabled`, `apply_enabled` — is a single short
//! critical section over that mutex, which is what closes the disable/lease
//! race: a disable and a lease cannot interleave, because whichever commits
//! second observes the first's effect under the same lock.
//!
//! The production lifecycle goes through [`ExtensionRegistry::apply_enabled`],
//! which keeps the disable's plugin cleanup, the descriptor snapshot and the
//! caller's notification inside the same critical section, so a concurrent
//! enable or lease serializes behind the whole change instead of slipping
//! between the flag update and the cleanup.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::domain::extensions::model_manifest::{ExtensionCatalog, DiscoveredPlugin};
use crate::common::error::{AppError, AppResult};

/// One extension's activation record.
#[derive(Debug, Clone)]
struct ActivationEntry {
    default_enabled: bool,
    /// None = still at the manifest default for this run.
    explicit: Option<bool>,
    /// Bumped on every accepted activation change.
    generation: u64,
}

impl ActivationEntry {
    fn is_enabled(&self) -> bool {
        self.explicit.unwrap_or(self.default_enabled)
    }
}

/// Entries and busy counters behind one mutex (see the module docs).
struct RegistryInner {
    entries: HashMap<String, ActivationEntry>,
    /// Extension id -> number of outstanding leases. A disable is rejected
    /// while any lease is held.
    busy: HashMap<String, u32>,
}

type SharedInner = Arc<Mutex<RegistryInner>>;

/// Runtime activation state for every built-in extension.
pub struct ExtensionRegistry {
    inner: SharedInner,
}

/// A busy lease on one extension.
///
/// Holding one means "an operation of this extension is in flight". While any
/// lease for an extension is outstanding, disabling that extension is
/// rejected. The lease snapshots the activation generation, so a task that
/// somehow outlives an activation change can detect it before writing plugin
/// state.
pub struct Lease {
    inner: SharedInner,
    extension_id: String,
    generation: u64,
    released: bool,
}

impl Lease {
    /// The activation generation this lease was taken under.
    ///
    /// A leased operation can compare this against a later registry
    /// generation before writing plugin state; the disable path cannot run
    /// while the lease exists, so this guards future forced-reset paths.
    #[allow(dead_code)] // contract surface; exercised by registry tests
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Releases the lease eagerly instead of waiting for Drop.
    #[cfg(test)]
    pub(crate) fn release(mut self) {
        self.released = true;
        release_busy(&self.inner, &self.extension_id);
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        release_busy(&self.inner, &self.extension_id);
    }
}

/// Drops one busy count. Runs on every exit path (Drop, explicit release),
/// so a crashed operation can never permanently block a later disable.
fn release_busy(inner: &SharedInner, extension_id: &str) {
    if let Ok(mut inner) = inner.lock() {
        if let Some(count) = inner.busy.get_mut(extension_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                inner.busy.remove(extension_id);
            }
        }
    }
}

impl ExtensionRegistry {
    /// Builds the registry from the merged catalog, every extension at its
    /// `defaultEnabled`.
    ///
    /// External entries are registered exactly like builtin ones: the lease /
    /// busy / generation machinery is id-keyed and source-agnostic, which is
    /// what lets an external caller's in-flight operation reject a disable.
    pub fn from_catalog(catalog: &ExtensionCatalog) -> Self {
        let mut entries = HashMap::new();
        for entry in &catalog.builtin.extensions {
            entries.insert(
                entry.id.clone(),
                ActivationEntry {
                    default_enabled: entry.default_enabled,
                    explicit: None,
                    generation: 0,
                },
            );
        }
        for plugin in &catalog.external {
            entries.insert(
                plugin.entry.id.clone(),
                ActivationEntry {
                    default_enabled: plugin.entry.default_enabled,
                    explicit: None,
                    generation: 0,
                },
            );
        }
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                entries,
                busy: HashMap::new(),
            })),
        }
    }

    /// Backwards-compatible constructor for the builtin-only manifest.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn from_manifest(manifest: &crate::domain::extensions::model_manifest::BuiltinManifest) -> Self {
        let mut entries = HashMap::new();
        for entry in &manifest.extensions {
            entries.insert(
                entry.id.clone(),
                ActivationEntry {
                    default_enabled: entry.default_enabled,
                    explicit: None,
                    generation: 0,
                },
            );
        }
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                entries,
                busy: HashMap::new(),
            })),
        }
    }

    /// Reconciles the activation entries with a freshly scanned catalog.
    ///
    /// Called after an install or a removal. The rules:
    ///
    /// - A newly discovered id gets an entry at its `defaultEnabled`, so a
    ///   just-installed plugin is usable without a restart.
    /// - An id that disappeared from the catalog is dropped, unless it is
    ///   busy: removing a directory while one of its operations is in flight
    ///   would strand that operation, so the entry survives until the lease
    ///   is released and the next reconcile collects it.
    /// - An id that is still present keeps its `explicit` flag and
    ///   generation. A re-scan must not silently re-enable something the
    ///   user turned off, and must not look like an activation change.
    pub fn reconcile_catalog(&self, catalog: &ExtensionCatalog) {
        let mut inner = self.inner.lock().expect("extension registry lock poisoned");

        let mut present: std::collections::HashSet<String> = std::collections::HashSet::new();
        for entry in &catalog.builtin.extensions {
            present.insert(entry.id.clone());
            inner
                .entries
                .entry(entry.id.clone())
                .or_insert_with(|| ActivationEntry {
                    default_enabled: entry.default_enabled,
                    explicit: None,
                    generation: 0,
                });
        }
        for plugin in &catalog.external {
            present.insert(plugin.entry.id.clone());
            inner
                .entries
                .entry(plugin.entry.id.clone())
                .or_insert_with(|| ActivationEntry {
                    default_enabled: plugin.entry.default_enabled,
                    explicit: None,
                    generation: 0,
                });
        }

        // Collect the busy ids first: `retain` needs `entries` mutably while
        // the predicate reads `busy`, and both live in the same struct.
        let busy: std::collections::HashSet<String> = inner
            .busy
            .iter()
            .filter(|(_, count)| **count > 0)
            .map(|(id, _)| id.clone())
            .collect();
        inner
            .entries
            .retain(|id, _| present.contains(id) || busy.contains(id));
    }

    /// Seeds one extension's persisted explicit flag from `state.json`.
    ///
    /// Startup-only: this records an already-committed previous run, so it
    /// must not look like a fresh generation bump. Runtime changes always go
    /// through [`ExtensionRegistry::apply_enabled`].
    pub fn seed_persisted(&self, extension_id: &str, enabled: bool) {
        let mut inner = self.inner.lock().expect("extension registry lock poisoned");
        if let Some(entry) = inner.entries.get_mut(extension_id) {
            entry.explicit = Some(enabled);
        }
    }

    /// Test-only: registers one extension id at its default, for states whose
    /// tests did not install a plugin directory.
    #[cfg(test)]
    pub(crate) fn test_register(&self, extension_id: &str) {
        let mut inner = self.inner.lock().expect("extension registry lock poisoned");
        inner.entries.entry(extension_id.to_string()).or_insert_with(|| ActivationEntry {
            default_enabled: true,
            explicit: None,
            generation: 0,
        });
    }

    /// Whether the extension is active for this run.
    ///
    /// Unknown ids are not active: a plugin call site that reaches an
    /// unregistered extension fails closed instead of guessing.
    pub fn is_enabled(&self, extension_id: &str) -> bool {
        self.inner
            .lock()
            .expect("extension registry lock poisoned")
            .entries
            .get(extension_id)
            .map(ActivationEntry::is_enabled)
            .unwrap_or(false)
    }

    /// Whether any operation of this extension is in flight.
    ///
    /// Used by uninstall: removing a plugin's directory while one of its
    /// operations holds a lease would strand that operation.
    pub fn is_busy(&self, extension_id: &str) -> bool {
        self.inner
            .lock()
            .expect("extension registry lock poisoned")
            .busy
            .get(extension_id)
            .is_some_and(|count| *count > 0)
    }

    /// The activation generation of one extension, for lease comparisons.
    #[allow(dead_code)] // contract surface; exercised by registry tests
    pub fn generation(&self, extension_id: &str) -> Option<u64> {
        self.inner
            .lock()
            .expect("extension registry lock poisoned")
            .entries
            .get(extension_id)
            .map(|entry| entry.generation)
    }

    /// Descriptors in catalog order (builtin then external), with the runtime
    /// activation folded in.
    ///
    /// Order comes from the catalog, so `list_extensions` and the
    /// `extensions-changed` event are stable regardless of hash order.
    pub fn descriptors(&self, catalog: &ExtensionCatalog) -> Vec<super::super::ExtensionDescriptor> {
        descriptors_locked(
            &self.inner.lock().expect("extension registry lock poisoned"),
            catalog,
        )
    }

    /// Simple flag transition without cleanup or notification.
    ///
    /// Test and seeding convenience; the production lifecycle goes through
    /// [`ExtensionRegistry::apply_enabled`], which keeps a disable's plugin
    /// cleanup inside the same critical section as the flag change.
    #[cfg(test)]
    pub fn set_enabled(&self, extension_id: &str, enabled: bool) -> AppResult<()> {
        let mut inner = self.inner.lock().expect("extension registry lock poisoned");
        Self::transition_locked(&mut inner, extension_id, enabled)?;
        Ok(())
    }

    /// Applies one activation change as a single serialized transaction.
    ///
    /// Busy check, persistence, flag update, the disable's plugin cleanup (in
    /// `on_committed`), the descriptor snapshot and the caller's notification
    /// all run under the registry mutex, so:
    ///
    /// - A concurrent [`lease`](ExtensionRegistry::lease) either lands
    ///   entirely before this change (the operation runs, and a disable is
    ///   then rejected as busy) or entirely after it (it observes the new
    ///   flag). No operation starts on an extension this change disables.
    /// - A concurrent lifecycle change serializes behind this one: an
    ///   off→on sequence can never clear state that a freshly enabled
    ///   operation already wrote, because the enable's lease is granted
    ///   only after this critical section — cleanup included — finished.
    /// - A persistence failure rejects the whole transition: the flag, the
    ///   generation, the cleanup and the event are never half-committed.
    ///
    /// `persist` and `on_committed` run while the mutex is still held; they
    /// must not call back into this registry (the mutex is not reentrant).
    /// The plugin cleanup and the Tauri emit both satisfy that.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn apply_enabled<F>(
        &self,
        extension_id: &str,
        enabled: bool,
        catalog: &ExtensionCatalog,
        on_committed: F,
    ) -> AppResult<Vec<super::super::ExtensionDescriptor>>
    where
        F: FnOnce(&[super::super::ExtensionDescriptor]),
    {
        self.apply_enabled_with_persist(extension_id, enabled, catalog, || Ok(()), on_committed)
    }

    /// [`apply_enabled`] with the persistence step inserted between the busy
    /// check and the flag commit (see the ordering there).
    ///
    /// `persist` runs before anything is mutated: a failed write rejects the
    /// transition with the registry untouched, which is what keeps a failed
    /// `state.json` write from publishing a successful flag/event.
    pub fn apply_enabled_with_persist<F, P>(
        &self,
        extension_id: &str,
        enabled: bool,
        catalog: &ExtensionCatalog,
        persist: P,
        on_committed: F,
    ) -> AppResult<Vec<super::super::ExtensionDescriptor>>
    where
        P: FnOnce() -> Result<(), String>,
        F: FnOnce(&[super::super::ExtensionDescriptor]),
    {
        let mut inner = self.inner.lock().expect("extension registry lock poisoned");
        // Validate first, mutate nothing: a rejected id/busy case is free.
        Self::check_transition_locked(&inner, extension_id, enabled)?;
        // Persist before the flag commit. Still inside the critical section,
        // so a concurrent lease cannot start between the write and the flag.
        persist().map_err(AppError::Runtime)?;
        Self::transition_locked(&mut inner, extension_id, enabled)?;
        let descriptors = descriptors_locked(&inner, catalog);
        on_committed(&descriptors);
        Ok(descriptors)
    }

    /// Takes a busy lease on one active extension.
    ///
    /// The enabled check and the busy increment share one critical section
    /// with the flag update in [`transition_locked`](Self::transition_locked):
    /// a disable that commits either happens entirely before this lease (and
    /// is observed here) or entirely after it (and sees this lease's busy
    /// count and is rejected). There is no instant at which both succeed.
    pub fn lease(&self, extension_id: &str) -> AppResult<Lease> {
        let mut inner = self.inner.lock().expect("extension registry lock poisoned");
        let entry = inner
            .entries
            .get(extension_id)
            .ok_or_else(|| AppError::NotFound(format!("extension {extension_id}")))?;
        if !entry.is_enabled() {
            return Err(AppError::Validation(format!(
                "extension {extension_id} is disabled; enable it first"
            )));
        }
        let generation = entry.generation;
        *inner.busy.entry(extension_id.to_string()).or_insert(0) += 1;
        Ok(Lease {
            inner: Arc::clone(&self.inner),
            extension_id: extension_id.to_string(),
            generation,
            released: false,
        })
    }

    /// Busy check (disable) and flag update, under the caller's lock.
    ///
    /// Rejections:
    /// - unknown id -> `NotFound`
    /// - disabling while leases are outstanding -> `Validation` (busy)
    ///
    /// Persistence lives in the caller ([`apply_enabled_with_persist`]),
    /// which orders it before this mutation.
    fn transition_locked(
        inner: &mut RegistryInner,
        extension_id: &str,
        enabled: bool,
    ) -> AppResult<()> {
        Self::check_transition_locked(inner, extension_id, enabled)?;
        let entry = inner
            .entries
            .get_mut(extension_id)
            .ok_or_else(|| AppError::NotFound(format!("extension {extension_id}")))?;
        if entry.explicit != Some(enabled) {
            entry.explicit = Some(enabled);
            entry.generation += 1;
        }
        Ok(())
    }

    /// The rejection half of [`transition_locked`] without any mutation.
    ///
    /// Extracted so `apply_enabled_with_persist` can validate *before* the
    /// disk write: a rejected transition must not have written state.json.
    fn check_transition_locked(
        inner: &RegistryInner,
        extension_id: &str,
        enabled: bool,
    ) -> AppResult<()> {
        if !enabled {
            let busy = inner.busy.get(extension_id).copied().unwrap_or(0);
            if busy > 0 {
                return Err(AppError::Validation(format!(
                    "extension {extension_id} has operations in flight; cancel or wait for them before disabling"
                )));
            }
        }
        if !inner.entries.contains_key(extension_id) {
            return Err(AppError::NotFound(format!("extension {extension_id}")));
        }
        Ok(())
    }
}

/// Descriptor rendering against a locked inner state.
///
/// Builtin rows keep their exact pre-external shape; external rows are
/// appended after them, `builtin: false`, same descriptor type.
fn descriptors_locked(
    inner: &RegistryInner,
    catalog: &ExtensionCatalog,
) -> Vec<super::super::ExtensionDescriptor> {
    let render = |id: &str,
                  display_name: &str,
                  version: &str,
                  api_version: i64,
                  builtin: bool,
                  default_enabled: bool,
                  contributes: &crate::domain::extensions::model_manifest::Contributes| {
        let enabled = inner
            .entries
            .get(id)
            .map(ActivationEntry::is_enabled)
            .unwrap_or(default_enabled);
        super::super::ExtensionDescriptor {
            id: id.to_string(),
            display_name: display_name.to_string(),
            version: version.to_string(),
            api_version,
            builtin,
            default_enabled,
            enabled,
            contributes: contributes.clone(),
        }
    };
    let mut descriptors: Vec<super::super::ExtensionDescriptor> = catalog
        .builtin
        .extensions
        .iter()
        .map(|entry| {
            render(
                &entry.id,
                &entry.display_name,
                &entry.version,
                entry.api_version,
                entry.builtin,
                entry.default_enabled,
                &entry.contributes,
            )
        })
        .collect();
    descriptors.extend(catalog.external.iter().map(
        |DiscoveredPlugin {
             entry,
             dir: _,
             canonical_dir: _,
         }: &DiscoveredPlugin| {
            render(
                &entry.id,
                &entry.display_name,
                &entry.version,
                entry.api_version,
                entry.builtin,
                entry.default_enabled,
                &entry.contributes,
            )
        },
    ));
    descriptors
}

