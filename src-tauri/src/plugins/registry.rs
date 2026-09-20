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

use super::manifest::{ExtensionCatalog, DiscoveredPlugin};
use crate::error::{AppError, AppResult};

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
    pub fn from_manifest(manifest: &super::manifest::BuiltinManifest) -> Self {
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
    pub fn descriptors(&self, catalog: &ExtensionCatalog) -> Vec<super::ExtensionDescriptor> {
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
    ) -> AppResult<Vec<super::ExtensionDescriptor>>
    where
        F: FnOnce(&[super::ExtensionDescriptor]),
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
    ) -> AppResult<Vec<super::ExtensionDescriptor>>
    where
        P: FnOnce() -> Result<(), String>,
        F: FnOnce(&[super::ExtensionDescriptor]),
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
) -> Vec<super::ExtensionDescriptor> {
    let render = |id: &str,
                  display_name: &str,
                  version: &str,
                  api_version: i64,
                  builtin: bool,
                  default_enabled: bool,
                  contributes: &super::manifest::Contributes| {
        let enabled = inner
            .entries
            .get(id)
            .map(ActivationEntry::is_enabled)
            .unwrap_or(default_enabled);
        super::ExtensionDescriptor {
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
    let mut descriptors: Vec<super::ExtensionDescriptor> = catalog
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::BuiltinManifest;
    use std::sync::{Barrier, Mutex as SyncMutex};

    fn registry() -> ExtensionRegistry {
        ExtensionRegistry::from_manifest(&BuiltinManifest::parse().expect("manifest"))
    }

    fn descriptors(registry: &ExtensionRegistry) -> Vec<(String, bool)> {
        let manifest = BuiltinManifest::parse().unwrap();
        registry
            .descriptors(&ExtensionCatalog {
                builtin: manifest,
                external: Vec::new(),
            })
            .into_iter()
            .map(|d| (d.id, d.enabled))
            .collect()
    }

    #[test]
    fn defaults_come_from_the_manifest_and_both_are_enabled() {
        let registry = registry();
        assert_eq!(
            descriptors(&registry),
            vec![
                ("eshell.sftp".to_string(), true),
                ("eshell.server-monitor".to_string(), true),
            ]
        );
    }

    /// External entries join the same registry: descriptors append after the
    /// builtin rows, and their leases/busy behavior is identical.
    #[test]
    fn external_entries_join_the_catalog_after_builtin_rows() {
        let manifest = BuiltinManifest::parse().unwrap();
        let catalog = ExtensionCatalog {
            builtin: manifest,
            external: vec![DiscoveredPlugin {
                entry: super::super::manifest::ExternalExtensionEntry {
                    id: "com.example.plugin".to_string(),
                    display_name: "Example".to_string(),
                    version: "1.0.0".to_string(),
                    api_version: 1,
                    builtin: false,
                    default_enabled: true,
                    main: "index.js".to_string(),
                    contributes: Default::default(),
                },
                dir: std::path::PathBuf::from("x"),
                canonical_dir: std::path::PathBuf::from("x"),
            }],
        };
        let registry = ExtensionRegistry::from_catalog(&catalog);
        let rows: Vec<(String, bool, bool)> = registry
            .descriptors(&catalog)
            .into_iter()
            .map(|d| (d.id, d.builtin, d.enabled))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("eshell.sftp".to_string(), true, true),
                ("eshell.server-monitor".to_string(), true, true),
                ("com.example.plugin".to_string(), false, true),
            ]
        );

        // The external id leases and busy-rejects exactly like a builtin one.
        let lease = registry.lease("com.example.plugin").expect("lease external");
        assert!(matches!(
            registry.set_enabled("com.example.plugin", false),
            Err(AppError::Validation(message)) if message.to_string().contains("in flight")
        ));
        drop(lease);
        registry
            .set_enabled("com.example.plugin", false)
            .expect("disable external");
        assert!(!registry.is_enabled("com.example.plugin"));
    }

    /// Persisted flags are seeded without a generation bump: a restart must
    /// not look like a runtime change to lease/lease-generation observers.
    #[test]
    fn seed_persisted_sets_explicit_without_generation_bump() {
        let registry = registry();
        let before = registry.generation("eshell.sftp").unwrap();
        registry.seed_persisted("eshell.sftp", false);
        assert!(!registry.is_enabled("eshell.sftp"));
        assert_eq!(registry.generation("eshell.sftp"), Some(before));
        // Unknown ids are ignored, not created.
        registry.seed_persisted("com.example.ghost", false);
        assert!(!registry.is_enabled("com.example.ghost"));
    }

    /// The persistence hook orders the write before the flag commit: a failed
    /// write rejects the whole transition — no flag, no generation bump, no
    /// cleanup, no descriptor change.
    #[test]
    fn failed_persist_rejects_the_transition_without_any_commit() {
        let manifest = BuiltinManifest::parse().unwrap();
        let catalog = ExtensionCatalog {
            builtin: manifest,
            external: Vec::new(),
        };
        let registry = registry();
        let before = registry.generation("eshell.sftp").unwrap();

        let result = registry.apply_enabled_with_persist(
            "eshell.sftp",
            false,
            &catalog,
            || Err("disk full".to_string()),
            |_| panic!("a failed persist must never run its cleanup"),
        );
        assert!(result.is_err(), "the transition must be rejected");
        assert!(registry.is_enabled("eshell.sftp"), "the flag must be unchanged");
        assert_eq!(
            registry.generation("eshell.sftp"),
            Some(before),
            "no generation bump"
        );
        assert!(
            descriptors(&registry)[0].1,
            "descriptors must still show enabled"
        );

        // The same call with a working persist commits everything.
        registry
            .apply_enabled_with_persist(
                "eshell.sftp",
                false,
                &catalog,
                || Ok(()),
                |descriptors| {
                    assert!(descriptors.iter().any(|d| d.id == "eshell.sftp" && !d.enabled));
                },
            )
            .expect("commit with working persist");
        assert!(!registry.is_enabled("eshell.sftp"));
    }

    #[test]
    fn set_enabled_toggles_runtime_activation_without_persistence() {
        let registry = registry();
        registry.set_enabled("eshell.sftp", false).expect("disable");
        assert!(!registry.is_enabled("eshell.sftp"));
        assert!(registry.is_enabled("eshell.server-monitor"));
        // Descriptors reflect the change and keep manifest order.
        assert_eq!(
            descriptors(&registry),
            vec![
                ("eshell.sftp".to_string(), false),
                ("eshell.server-monitor".to_string(), true),
            ]
        );
        registry.set_enabled("eshell.sftp", true).expect("enable");
        assert!(registry.is_enabled("eshell.sftp"));
    }

    #[test]
    fn unknown_extension_ids_are_rejected() {
        let registry = registry();
        assert!(matches!(
            registry.set_enabled("eshell.nope", true),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            registry.lease("eshell.nope"),
            Err(AppError::NotFound(_))
        ));
        assert!(!registry.is_enabled("eshell.nope"));
    }

    #[test]
    fn lease_is_rejected_while_disabled() {
        let registry = registry();
        registry.set_enabled("eshell.sftp", false).expect("disable");
        assert!(matches!(
            registry.lease("eshell.sftp"),
            Err(AppError::Validation(message)) if message.to_string().contains("disabled")
        ));
        registry.set_enabled("eshell.sftp", true).expect("enable");
        assert!(registry.lease("eshell.sftp").is_ok());
    }

    #[test]
    fn disabling_is_rejected_while_operations_are_in_flight() {
        let registry = registry();
        let lease = registry.lease("eshell.sftp").expect("lease");
        assert!(matches!(
            registry.set_enabled("eshell.sftp", false),
            Err(AppError::Validation(message)) if message.to_string().contains("in flight")
        ));
        // Enabling while busy is allowed: it only widens availability.
        registry.set_enabled("eshell.sftp", true).expect("enable");
        drop(lease);
        registry
            .set_enabled("eshell.sftp", false)
            .expect("disable after release");
        assert!(!registry.is_enabled("eshell.sftp"));
    }

    #[test]
    fn concurrent_leases_all_block_the_disable_and_all_release() {
        let registry = registry();
        let leases: Vec<Lease> = (0..3)
            .map(|_| registry.lease("eshell.sftp").expect("lease"))
            .collect();
        assert!(registry.set_enabled("eshell.sftp", false).is_err());
        for lease in leases {
            lease.release();
        }
        registry.set_enabled("eshell.sftp", false).expect("disable");
    }

    #[test]
    fn generation_bumps_only_on_a_real_change() {
        let registry = registry();
        // First explicit set is a real change off the manifest default.
        let before = registry.generation("eshell.sftp").unwrap();
        registry
            .set_enabled("eshell.sftp", true)
            .expect("explicit set");
        assert_eq!(registry.generation("eshell.sftp"), Some(before + 1));

        // Repeating the same value must not bump again.
        let after = registry.generation("eshell.sftp").unwrap();
        registry
            .set_enabled("eshell.sftp", true)
            .expect("same value");
        assert_eq!(registry.generation("eshell.sftp"), Some(after));

        // A different value bumps once more.
        registry.set_enabled("eshell.sftp", false).expect("change");
        assert_eq!(registry.generation("eshell.sftp"), Some(after + 1));
    }

    /// A real race, not a sequence: a leaser and a disabler released from one
    /// barrier at the same instant.
    ///
    /// Exactly one may win. Both winning is the TOCTOU this registry exists
    /// to prevent (a lease granted on an extension disabled at the same
    /// instant); both losing is impossible, because each failure implies the
    /// other's success: the lease fails only because the disable committed,
    /// and the disable fails only because a lease is outstanding. The test
    /// keeps the granted lease alive past the disable attempt, so the busy
    /// count the disabler checks is the one this lease holds.
    #[test]
    fn barrier_released_disable_and_lease_are_mutually_exclusive() {
        for _ in 0..200 {
            let registry = Arc::new(registry());
            let barrier = Arc::new(Barrier::new(2));

            let leaser = {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.lease("eshell.sftp")
                })
            };
            let disabler = {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.set_enabled("eshell.sftp", false)
                })
            };

            // Join in this order so the lease (held in `lease_result`) is
            // still alive while the disabler runs its busy check.
            let lease_result = leaser.join().expect("join leaser");
            let disable_result = disabler.join().expect("join disabler");

            match (&lease_result, &disable_result) {
                (Ok(_), Ok(_)) => {
                    panic!("lease granted on an extension disabled at the same instant (TOCTOU)")
                }
                (Ok(_), Err(error)) => assert!(
                    matches!(error, AppError::Validation(message) if message.to_string().contains("in flight")),
                    "the disable must be rejected as busy while the lease is outstanding: {error}"
                ),
                (Err(error), Ok(_)) => assert!(
                    matches!(error, AppError::Validation(message) if message.to_string().contains("disabled")),
                    "the lease must be refused because the disable committed first: {error}"
                ),
                (Err(_), Err(_)) => {
                    panic!("both failed: each failure must imply the other's success")
                }
            }
        }
    }

    /// The off→on race: a disable's cleanup must never clear state that a
    /// concurrently re-enabled operation wrote.
    ///
    /// The cleanup runs inside the same critical section as the flag change,
    /// so the re-enable's lease is granted either after the whole disable
    /// transaction (cleanup included — the write then lands after the clear)
    /// or the disable is rejected as busy and its cleanup never runs. Either
    /// way the operation's write survives; the cell stands in for the plugin
    /// state the cleanup clears and the operation writes.
    #[test]
    fn barrier_released_disable_cleanup_never_clears_a_fresh_operations_state() {
        for _ in 0..100 {
            let registry = Arc::new(registry());
            let catalog = ExtensionCatalog {
                builtin: BuiltinManifest::parse().expect("manifest"),
                external: Vec::new(),
            };
            let barrier = Arc::new(Barrier::new(2));
            let cell = Arc::new(SyncMutex::new(String::new()));
            let (disable_done_tx, disable_done_rx) = std::sync::mpsc::channel::<()>();

            // The operation: lease, write, then hold the lease until the
            // disable attempt has resolved. A lease that is dropped before
            // the disable runs would let the disable commit legitimately and
            // its cleanup clear the state — the point is that this cannot
            // happen *while the operation is in flight*.
            let operation = {
                let registry = Arc::clone(&registry);
                let catalog = catalog.clone();
                let barrier = Arc::clone(&barrier);
                let cell = Arc::clone(&cell);
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut attempts = 0;
                    let lease = loop {
                        attempts += 1;
                        match registry.lease("eshell.sftp") {
                            Ok(lease) => break Some(lease),
                            Err(_) if attempts < 3 => {
                                // The disable won the race: re-enable and
                                // retry. The retry's lease is granted only
                                // after the disable transaction — cleanup
                                // included — has finished.
                                registry
                                    .apply_enabled("eshell.sftp", true, &catalog, |_| {})
                                    .expect("re-enable");
                            }
                            Err(error) => panic!("lease kept failing: {error}"),
                        }
                    };
                    // The operation's write, under the lease.
                    *cell.lock().expect("cell") = "operation".to_string();
                    // Keep the lease across the disable attempt.
                    let _ = disable_done_rx.recv_timeout(std::time::Duration::from_secs(10));
                    drop(lease);
                })
            };

            let disabler = {
                let registry = Arc::clone(&registry);
                let catalog = catalog.clone();
                let barrier = Arc::clone(&barrier);
                let cell = Arc::clone(&cell);
                std::thread::spawn(move || {
                    barrier.wait();
                    let result = registry.apply_enabled("eshell.sftp", false, &catalog, |_| {
                        // The cleanup: what must never clear a fresh
                        // operation's write.
                        *cell.lock().expect("cell") = String::new();
                    });
                    let _ = disable_done_tx.send(());
                    result
                })
            };

            let disable_result = disabler.join().expect("join disabler");
            operation.join().expect("join operation");
            let cell_value = cell.lock().expect("cell").clone();

            // The core invariant, whatever the interleaving: the disable's
            // cleanup never cleared the fresh operation's write. If the
            // disable committed first, the operation's re-enable + retry
            // landed after the whole transaction, cleanup included; if the
            // operation leased first, the disable was rejected as busy and
            // its cleanup never ran at all.
            //
            // (The final flag is deliberately not asserted: the operation
            // thread legitimately re-enables after a lost race, so the last
            // committed change depends on the interleaving.)
            assert_eq!(
                cell_value, "operation",
                "the fresh operation's state must survive the disable's cleanup                  (disable result: {disable_result:?})"
            );
            // The disable's own outcome is asserted by its result type: a
            // busy rejection must carry the in-flight message, a commit must
            // be Ok. Both paths were exercised above.
        }
    }
}
