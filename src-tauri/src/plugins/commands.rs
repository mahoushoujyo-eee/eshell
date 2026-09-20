//! Tauri commands for the extension lifecycle.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::to_command_error;
use crate::plugins::ExtensionDescriptor;
use crate::plugins::protocol;
use crate::state::AppState;

/// `extensions-changed` event name, matching the shared contract.
pub const EXTENSIONS_CHANGED_EVENT: &str = "extensions-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExtensionEnabledInput {
    pub extension_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionInput {
    /// Absolute path to the plugin directory the user picked.
    pub source_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallExtensionInput {
    pub extension_id: String,
}

/// Outcome of an install: the id that was installed and the refreshed
/// catalog, so the caller can render the new row without a second round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionResult {
    pub extension_id: String,
    pub display_name: String,
    pub extensions: Vec<ExtensionDescriptor>,
}

/// One external plugin row for `list_external_plugins`: the manifest fields
/// the frontend already knows, plus `enabled`, `main` and the bundle URL.
///
/// `builtin` is always `false` here; builtin descriptors never grow these
/// fields (they have no bundle).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginDescriptor {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub api_version: i64,
    pub builtin: bool,
    pub default_enabled: bool,
    pub enabled: bool,
    pub main: String,
    pub bundle_url: String,
    pub contributes: crate::plugins::manifest::Contributes,
}

/// Lists the merged extensions (builtin + discovered external) with their
/// runtime activation state.
///
/// Metadata comes from `extensions/builtin.json` plus the discovered
/// external manifests; the `enabled` flag is this run's activation, seeded
/// from `extensions/state.json` at startup and persisted on every accepted
/// toggle.
#[tauri::command]
pub fn list_extensions(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ExtensionDescriptor>, String> {
    Ok(state.extensions().descriptors(&state.extensions_catalog()))
}

/// Lists the discovered external plugins with their bundle URLs.
///
/// Only discovered-and-validated plugin directories appear here; a broken
/// manifest was logged and skipped at startup. The UI loader pairs this with
/// [`list_extensions`] for the merged catalog.
#[tauri::command]
pub fn list_external_plugins(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ExternalPluginDescriptor>, String> {
    let catalog = state.extensions_catalog();
    let rows = catalog
        .external
        .iter()
        .map(|plugin| ExternalPluginDescriptor {
            id: plugin.entry.id.clone(),
            display_name: plugin.entry.display_name.clone(),
            version: plugin.entry.version.clone(),
            api_version: plugin.entry.api_version,
            builtin: false,
            default_enabled: plugin.entry.default_enabled,
            enabled: state.extensions().is_enabled(&plugin.entry.id),
            main: plugin.entry.main.clone(),
            bundle_url: protocol::bundle_url(plugin),
            contributes: plugin.entry.contributes.clone(),
        })
        .collect();
    Ok(rows)
}

/// Enables or disables one extension for this application run.
///
/// On success this returns the complete descriptor list (the same shape as
/// [`list_extensions`]) and emits `extensions-changed` with that list, and
/// the change is persisted to `extensions/state.json`.
///
/// Rejections surface as Tauri command errors:
/// - unknown extension id
/// - disabling while an operation is in flight (busy lease)
/// - a failed `state.json` write: the whole transition is rejected, so no
///   flag, cleanup or event is half-committed
///
/// Disabling never closes user SSH sessions; the plugin clears only its own
/// bookkeeping (see [`crate::plugins::lifecycle::apply_activation`]).
#[tauri::command]
pub fn set_extension_enabled(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    input: SetExtensionEnabledInput,
) -> Result<Vec<ExtensionDescriptor>, String> {
    // One serialized lifecycle transaction: busy check, persistence, flag
    // update, the disable's plugin cleanup, the descriptor snapshot and the
    // extensions-changed emit all share the registry's critical section, so
    // a concurrent enable or lease serializes behind the whole change
    // instead of slipping between the flag update and the cleanup.
    let extension_id = input.extension_id.clone();
    let enabled = input.enabled;
    let app_handle = app.clone();
    let catalog = state.extensions_catalog();
    state
        .extensions()
        .apply_enabled_with_persist(
            &extension_id,
            enabled,
            &catalog,
            || state.persist_extension_enabled(&extension_id, enabled),
            |descriptors| {
                // Plugin cleanup for an accepted disable, before the
                // snapshot or the emit. A rejected change never gets here.
                crate::plugins::lifecycle::apply_activation(&state, &extension_id, enabled);
                let _ = app_handle.emit(EXTENSIONS_CHANGED_EVENT, descriptors);
            },
        )
        .map_err(to_command_error)
}

/// Copies a user-picked plugin directory into `extensions/<id>/` and makes it
/// live without a restart.
///
/// The source directory is validated by the same discovery rules as a startup
/// scan: the manifest must parse, `apiVersion` must match, `builtin` must be
/// false, and `main` must resolve inside the directory. A directory that
/// fails validation is rejected *before* anything is copied, so a bad pick
/// cannot leave a half-installed plugin behind.
///
/// The destination is derived from the manifest id, never from the source
/// directory's name, and the id has already passed the discovery identity
/// rules (no separators, no `..`), so it cannot escape `extensions/`.
///
/// Installing over an existing id replaces it. The old copy is moved aside
/// first and restored if the new copy fails, so a failed replace never
/// destroys a working plugin.
#[tauri::command]
pub fn install_extension(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    input: InstallExtensionInput,
) -> Result<InstallExtensionResult, String> {
    let source = std::path::PathBuf::from(input.source_dir.trim());
    let installed = crate::plugins::install::install_from_dir(state.inner(), &source)
        .map_err(to_command_error)?;

    let descriptors = state.extensions().descriptors(&state.extensions_catalog());
    let _ = app.emit(EXTENSIONS_CHANGED_EVENT, &descriptors);
    Ok(InstallExtensionResult {
        extension_id: installed.id,
        display_name: installed.display_name,
        extensions: descriptors,
    })
}

/// Removes an installed external plugin's directory and drops it from the
/// catalog without a restart.
///
/// Refused for a builtin extension (its code ships with the app) and while
/// the plugin holds a busy lease: deleting a directory out from under an
/// in-flight operation would strand it.
///
/// The directory is moved to a temporary sibling and deleted after the
/// catalog swap, so a failed removal leaves the plugin installed rather than
/// half-deleted.
#[tauri::command]
pub fn uninstall_extension(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    input: UninstallExtensionInput,
) -> Result<Vec<ExtensionDescriptor>, String> {
    crate::plugins::install::uninstall(state.inner(), &input.extension_id)
        .map_err(to_command_error)?;

    let descriptors = state.extensions().descriptors(&state.extensions_catalog());
    let _ = app.emit(EXTENSIONS_CHANGED_EVENT, &descriptors);
    Ok(descriptors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state() -> std::sync::Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-ext-commands-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::sync::Arc::new(AppState::new(root).expect("create test state"))
    }

    #[test]
    fn extensions_changed_event_name_matches_the_contract() {
        assert_eq!(EXTENSIONS_CHANGED_EVENT, "extensions-changed");
    }

    /// The descriptor list matches the shared manifest field for field, with
    /// the runtime `enabled` folded in, in manifest order.
    #[test]
    fn descriptors_mirror_the_shared_manifest_plus_enabled() {
        let state = temp_state();
        let descriptors = state.extensions().descriptors(&state.extensions_catalog());

        assert_eq!(descriptors.len(), 2);
        let sftp = &descriptors[0];
        assert_eq!(sftp.id, "eshell.sftp");
        assert_eq!(sftp.display_name, "SFTP");
        assert!(sftp.builtin);
        assert!(sftp.default_enabled);
        assert!(sftp.enabled);
        assert_eq!(sftp.api_version, 1);
        assert_eq!(
            sftp.contributes.panels,
            vec![crate::plugins::manifest::ContributedPanel {
                id: "sftp".to_string(),
                order: 10,
            }]
        );

        let monitor = &descriptors[1];
        assert_eq!(monitor.id, "eshell.server-monitor");
        assert_eq!(monitor.display_name, "Server Monitor");
        assert_eq!(
            monitor.contributes.panels,
            vec![crate::plugins::manifest::ContributedPanel {
                id: "status".to_string(),
                order: 20,
            }]
        );
    }

    /// Runtime toggles are reflected in descriptors and are not persisted:
    /// a fresh state (the restart case) returns to `defaultEnabled`.
    #[test]
    fn runtime_toggles_are_reflected_and_not_persisted() {
        let state = temp_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("toggle");

        let descriptors = state.extensions().descriptors(&state.extensions_catalog());
        assert!(!descriptors[0].enabled);
        assert!(
            descriptors[0].default_enabled,
            "the default must stay recorded"
        );
        assert!(descriptors[1].enabled);

        // The restart case: a brand-new registry starts from the manifest.
        let fresh = temp_state();
        let fresh_descriptors = fresh.extensions().descriptors(&fresh.extensions_catalog());
        assert!(fresh_descriptors[0].enabled);
        assert!(fresh_descriptors[1].enabled);
    }

    /// Unknown ids and busy-disables are rejected without state change.
    #[test]
    fn rejected_lifecycle_changes_leave_state_untouched() {
        let state = temp_state();

        let unknown = state.extensions().set_enabled("eshell.ghost", true);
        assert!(unknown.is_err());
        assert!(!state.extensions().is_enabled("eshell.ghost"));

        // Lease the SFTP extension (an operation in flight) and try to disable.
        let lease = state.extensions().lease("eshell.sftp").expect("lease");
        let busy = state.extensions().set_enabled("eshell.sftp", false);
        assert!(busy.is_err());
        assert!(state.extensions().is_enabled("eshell.sftp"));
        drop(lease);

        // After the operation finishes, the same disable succeeds.
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable");
        assert!(!state.extensions().is_enabled("eshell.sftp"));
    }

    /// The lifecycle transaction: an accepted disable carries its cleanup,
    /// descriptor snapshot and emit inside one registry critical section, so
    /// a concurrent lease cannot start between the flag update and the
    /// cleanup. The lease either runs (and the disable is busy-rejected) or
    /// is refused because the disable committed.
    #[test]
    fn lifecycle_transaction_is_atomic_with_respect_to_leases() {
        let state = temp_state();

        // An operation in flight: the disable must be busy-rejected.
        let lease = crate::plugins::lifecycle::require_plugin_active(&state, "eshell.sftp")
            .expect("lease the active extension");
        let descriptors = state.extensions().apply_enabled(
            "eshell.sftp",
            false,
            &state.extensions_catalog(),
            |_| panic!("a busy-rejected disable must never run its cleanup"),
        );
        assert!(descriptors.is_err(), "the disable must be busy-rejected");
        assert!(state.extensions().is_enabled("eshell.sftp"));
        drop(lease);

        // The operation finished: the same transaction commits, cleanup
        // included, and the descriptor reflects it.
        let descriptors = state
            .extensions()
            .apply_enabled(
                "eshell.sftp",
                false,
                &state.extensions_catalog(),
                |descriptors| {
                    assert!(
                        descriptors
                            .iter()
                            .any(|d| d.id == "eshell.sftp" && !d.enabled),
                        "the snapshot must reflect the committed change"
                    );
                },
            )
            .expect("commit after the lease dropped");
        assert!(descriptors
            .iter()
            .any(|d| d.id == "eshell.sftp" && !d.enabled));
        assert!(!state.extensions().is_enabled("eshell.sftp"));
    }

    /// A lease taken after a committed disable is refused: the gate and the
    /// flag cannot disagree.
    #[test]
    fn lease_after_a_committed_disable_is_refused() {
        let state = temp_state();
        state
            .extensions()
            .apply_enabled("eshell.sftp", false, &state.extensions_catalog(), |_| {})
            .expect("disable");

        match crate::plugins::lifecycle::require_plugin_active(&state, "eshell.sftp") {
            Err(error) => assert!(
                error.to_string().contains("disabled"),
                "the refusal must name the disabled extension: {error}"
            ),
            Ok(_) => panic!("a disabled extension must refuse the lease"),
        }
    }

    /// `apply_activation` after an accepted disable clears only the target
    /// plugin's own state; the other extension and user SSH sessions stay.
    #[test]
    fn apply_activation_after_a_disable_clears_only_that_plugin() {
        let state = temp_state();
        use crate::models::now_rfc3339;
        state.put_session(crate::models::ShellSession {
            id: "session-1".to_string(),
            config_id: "config-1".to_string(),
            config_name: "Test host".to_string(),
            current_dir: "/home/test".to_string(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        });

        state
            .extensions()
            .set_enabled("eshell.server-monitor", false)
            .expect("disable");
        crate::plugins::lifecycle::apply_activation(&state, "eshell.server-monitor", false);

        // The tab (and its SSH connection) survive the disable.
        assert!(state.get_session("session-1").is_ok());
        // The SFTP extension is untouched.
        assert!(state.extensions().is_enabled("eshell.sftp"));
    }

    /// A real discovered plugin: `AppState::new` discovers it, the catalog
    /// carries it, `list_external_plugins` returns its descriptor with the
    /// platform bundle URL, and the directory name need not equal the id.
    #[test]
    fn list_external_plugins_returns_descriptor_main_and_bundle_url() {
        let root = std::env::temp_dir().join(format!(
            "eshell-list-external-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = root.join("extensions").join("a-folder-not-the-id");
        std::fs::create_dir_all(&plugin_dir).expect("mkdir");
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{
                "id": "com.example.plugin",
                "displayName": "Example",
                "version": "1.2.3",
                "apiVersion": 1,
                "builtin": false,
                "defaultEnabled": true,
                "main": "index.js",
                "contributes": {"panels": [{"id": "example", "order": 30}]}
            }"#,
        )
        .expect("write manifest");
        std::fs::write(plugin_dir.join("index.js"), "export default 1;").expect("write entry");

        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));
        // `list_extensions` merges the external row after the builtin ones.
        let merged = state.extensions().descriptors(&state.extensions_catalog());
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[2].id, "com.example.plugin");
        assert!(!merged[2].builtin);
        assert!(merged[2].default_enabled);
        assert!(merged[2].enabled);
        assert_eq!(merged[2].contributes.panels.len(), 1);

        // `list_external_plugins` (the command body, sans Tauri State).
        let catalog = state.extensions_catalog();
        let rows: Vec<ExternalPluginDescriptor> = catalog
            .external
            .iter()
            .map(|plugin| ExternalPluginDescriptor {
                id: plugin.entry.id.clone(),
                display_name: plugin.entry.display_name.clone(),
                version: plugin.entry.version.clone(),
                api_version: plugin.entry.api_version,
                builtin: false,
                default_enabled: plugin.entry.default_enabled,
                enabled: state.extensions().is_enabled(&plugin.entry.id),
                main: plugin.entry.main.clone(),
                bundle_url: protocol::bundle_url(plugin),
                contributes: plugin.entry.contributes.clone(),
            })
            .collect();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, "com.example.plugin");
        assert_eq!(row.display_name, "Example");
        assert_eq!(row.version, "1.2.3");
        assert!(!row.builtin);
        assert!(row.enabled);
        assert_eq!(row.main, "index.js");
        if cfg!(windows) {
            assert_eq!(
                row.bundle_url,
                "http://plugin.localhost/com.example.plugin/index.js"
            );
        } else {
            assert_eq!(
                row.bundle_url,
                "plugin://localhost/com.example.plugin/index.js"
            );
        }
        // The descriptor serializes camelCase for the frontend.
        let json = serde_json::to_value(&rows[0]).expect("serialize");
        assert!(json.get("displayName").is_some());
        assert!(json.get("bundleUrl").is_some());
        assert!(json.get("main").is_some());
        assert!(json.get("apiVersion").is_some());
        assert!(json.get("defaultEnabled").is_some());
        assert!(json.get("display_name").is_none());

        // A broken sibling is isolated: it appears in neither list.
        let broken = root.join("extensions").join("z-broken");
        std::fs::create_dir_all(&broken).expect("mkdir");
        std::fs::write(broken.join("manifest.json"), "{").expect("write broken");
        let fresh = AppState::new(root.clone()).expect("fresh state");
        assert_eq!(fresh.extensions_catalog().external.len(), 1);
        assert_eq!(
            fresh.extensions_catalog().external[0].entry.id,
            "com.example.plugin"
        );
    }

    /// The persisted lifecycle end to end: an accepted toggle writes
    /// `state.json`; a restart resumes the persisted flag; a rejected (busy)
    /// toggle writes nothing.
    #[test]
    fn persisted_lifecycle_survives_restart_and_rejects_busy() {
        let root = std::env::temp_dir().join(format!(
            "eshell-persisted-lifecycle-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = root.join("extensions").join("a-plugin");
        std::fs::create_dir_all(&plugin_dir).expect("mkdir");
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{
                "id": "com.example.persisted",
                "displayName": "P",
                "version": "1.0.0",
                "apiVersion": 1,
                "builtin": false,
                "defaultEnabled": true
            }"#,
        )
        .expect("write manifest");
        std::fs::write(plugin_dir.join("index.js"), "export default 1;").expect("write entry");

        // Run one: disable through the production transaction, with the real
        // persistence hook.
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state one"));
        let hook_state = std::sync::Arc::clone(&state);
        state
            .extensions()
            .apply_enabled_with_persist(
                "com.example.persisted",
                false,
                &state.extensions_catalog(),
                move || {
                    hook_state.persist_extension_enabled("com.example.persisted", false)
                },
                |_| {},
            )
            .expect("persisted disable");
        assert!(
            state
                .persisted_extension_enabled("com.example.persisted")
                .is_some(),
            "the flag must be persisted"
        );

        // Run two (restart): the persisted disable is resumed, not defaulted.
        let restarted = AppState::new(root.clone()).expect("state two");
        assert!(
            !restarted.extensions().is_enabled("com.example.persisted"),
            "a restart must resume the persisted disable"
        );
        let rows = restarted.extensions().descriptors(&restarted.extensions_catalog());
        let row = rows
            .iter()
            .find(|row| row.id == "com.example.persisted")
            .expect("external row");
        assert!(!row.enabled);
        assert!(row.default_enabled, "the manifest default stays recorded");

        // Re-enable through the transaction so the busy test can lease it.
        restarted
            .extensions()
            .apply_enabled_with_persist(
                "com.example.persisted",
                true,
                &restarted.extensions_catalog(),
                || {
                    restarted.persist_extension_enabled("com.example.persisted", true)
                },
                |_| {},
            )
            .expect("re-enable");
        assert!(restarted.extensions().is_enabled("com.example.persisted"));

        // A busy transition is rejected and persists nothing: lease the
        // extension (an operation in flight), then attempt a change.
        let lease = restarted
            .extensions()
            .lease("com.example.persisted")
            .expect("lease the re-enabled extension");
        let before = std::fs::read_to_string(root.join("extensions").join("state.json"))
            .expect("state file exists");
        // The attempted change is a disable: that is the transition a
        // busy lease must reject. (An enable is never busy-gated.)
        let rejected = restarted.extensions().apply_enabled_with_persist(
            "com.example.persisted",
            false,
            &restarted.extensions_catalog(),
            || {
                restarted.persist_extension_enabled("com.example.persisted", false)
            },
            |_| panic!("a busy-rejected change must never run its cleanup"),
        );
        assert!(rejected.is_err(), "the busy change must be rejected");
        assert!(
            restarted.extensions().is_enabled("com.example.persisted"),
            "the flag must survive the rejection"
        );
        drop(lease);
        let after = std::fs::read_to_string(root.join("extensions").join("state.json"))
            .expect("state file exists");
        assert_eq!(before, after, "a rejected change must not touch the file");
        // The disable goes through once the operation finished.
        restarted
            .extensions()
            .apply_enabled_with_persist(
                "com.example.persisted",
                false,
                &restarted.extensions_catalog(),
                || {
                    restarted.persist_extension_enabled("com.example.persisted", false)
                },
                |_| {},
            )
            .expect("disable after the lease dropped");
        assert!(!restarted.extensions().is_enabled("com.example.persisted"));
    }

    /// A failed `state.json` write rejects the whole transition: the flag, the
    /// descriptor and the file all stay at their pre-transition values, and no
    /// successful state/event is published.
    #[test]
    fn failed_persistence_rejects_the_whole_transition() {
        let root = std::env::temp_dir().join(format!(
            "eshell-failed-persistence-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = root.join("extensions").join("a-plugin");
        std::fs::create_dir_all(&plugin_dir).expect("mkdir");
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{
                "id": "com.example.failing",
                "displayName": "F",
                "version": "1.0.0",
                "apiVersion": 1,
                "builtin": false,
                "defaultEnabled": true
            }"#,
        )
        .expect("write manifest");
        std::fs::write(plugin_dir.join("index.js"), "export default 1;").expect("write entry");

        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));
        let state_file = root.join("extensions").join("state.json");

        // Make one accepted transition first, so the failure path is provably
        // rolling back a real prior state, not testing a missing file.
        state
            .extensions()
            .apply_enabled_with_persist(
                "com.example.failing",
                true,
                &state.extensions_catalog(),
                || state.persist_extension_enabled("com.example.failing", true),
                |_| {},
            )
            .expect("seed one accepted save");
        assert!(state_file.exists(), "the accepted save created the file");
        let before = std::fs::read_to_string(&state_file).expect("read prior state");

        // Occupy the state path: the temp write under it and the rename onto
        // it both fail, on Windows and Unix alike.
        std::fs::remove_file(&state_file).expect("remove file");
        std::fs::create_dir(&state_file).expect("occupy the state path");

        let rejected = state.extensions().apply_enabled_with_persist(
            "com.example.failing",
            false,
            &state.extensions_catalog(),
            || state.persist_extension_enabled("com.example.failing", false),
            |_| panic!("a failed persist must never run its cleanup or emit"),
        );
        assert!(rejected.is_err(), "the transition must be rejected");
        assert!(
            state.extensions().is_enabled("com.example.failing"),
            "the flag must be unchanged"
        );
        let rows = state.extensions().descriptors(&state.extensions_catalog());
        let row = rows
            .iter()
            .find(|row| row.id == "com.example.failing")
            .expect("row");
        assert!(row.enabled, "descriptors must still show enabled");

        // The occupied path is still a directory: no partial file was written.
        assert!(state_file.is_dir(), "no half-commit may replace the target");

        // Restore the path and prove the prior accepted state survived
        // untouched (the failed transition never rewound it either).
        std::fs::remove_dir(&state_file).expect("remove occupied dir");
        std::fs::write(&state_file, &before).expect("restore prior state");
        let resumed = AppState::new(root.clone()).expect("state three");
        assert!(
            resumed.extensions().is_enabled("com.example.failing"),
            "the prior accepted state is what a restart resumes"
        );
    }

    /// Writes a valid plugin directory at `dir` with the given id.
    fn write_plugin(dir: &std::path::Path, id: &str) {
        std::fs::create_dir_all(dir).expect("mkdir");
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{
                    "id": "{id}",
                    "displayName": "Installed {id}",
                    "version": "1.0.0",
                    "apiVersion": 1,
                    "builtin": false,
                    "defaultEnabled": true,
                    "main": "index.js"
                }}"#
            ),
        )
        .expect("write manifest");
        std::fs::write(dir.join("index.js"), "export default 1;").expect("write entry");
    }

    fn temp_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("eshell-{name}-{}", uuid::Uuid::new_v4().simple()))
    }

    /// Installing copies the directory in, derives the destination from the
    /// manifest id (not the source folder name), and makes it live without a
    /// restart.
    #[test]
    fn install_copies_by_manifest_id_and_activates_without_restart() {
        let root = temp_root("install-ok");
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));
        assert_eq!(state.extensions_catalog().external.len(), 0);

        // The source folder name deliberately differs from the manifest id.
        let source = temp_root("install-src").join("some-folder-name");
        write_plugin(&source, "com.example.installed");

        let installed =
            crate::plugins::install::install_from_dir(&state, &source).expect("install");
        assert_eq!(installed.id, "com.example.installed");

        // Copied to extensions/<id>/, not extensions/<source folder name>/.
        let destination = root.join("extensions").join("com.example.installed");
        assert!(destination.join("manifest.json").is_file());
        assert!(destination.join("index.js").is_file());

        // Live immediately: catalog and descriptors both see it, enabled.
        let catalog = state.extensions_catalog();
        assert_eq!(catalog.external.len(), 1);
        assert_eq!(catalog.external[0].entry.id, "com.example.installed");
        let merged = state.extensions().descriptors(&catalog);
        let row = merged
            .iter()
            .find(|row| row.id == "com.example.installed")
            .expect("row");
        assert!(row.enabled, "a freshly installed plugin starts enabled");
    }

    /// A directory that fails discovery is rejected before anything is
    /// copied, so a bad pick cannot leave a half-installed plugin behind.
    #[test]
    fn install_rejects_an_invalid_plugin_without_copying() {
        let root = temp_root("install-bad");
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));

        let source = temp_root("install-bad-src");
        std::fs::create_dir_all(&source).expect("mkdir");
        // `apiVersion: 2` is unsupported, so discovery rejects it.
        std::fs::write(
            source.join("manifest.json"),
            r#"{"id":"com.example.bad","displayName":"Bad","version":"1",
                "apiVersion":2,"builtin":false,"main":"index.js"}"#,
        )
        .expect("write manifest");
        std::fs::write(source.join("index.js"), "export default 1;").expect("write entry");

        let error = crate::plugins::install::install_from_dir(&state, &source)
            .expect_err("unsupported apiVersion must be rejected");
        assert!(
            format!("{error:?}").contains("apiVersion"),
            "the error must name the real problem: {error:?}"
        );
        assert_eq!(state.extensions_catalog().external.len(), 0);
        assert!(
            !root.join("extensions").join("com.example.bad").exists(),
            "a rejected install must not leave a directory behind"
        );
    }

    /// A directory with no manifest is named as such rather than reported as
    /// a generic validation failure.
    #[test]
    fn install_reports_a_missing_manifest() {
        let root = temp_root("install-nomanifest");
        let state = std::sync::Arc::new(AppState::new(root).expect("state"));
        let source = temp_root("install-nomanifest-src");
        std::fs::create_dir_all(&source).expect("mkdir");

        let error = crate::plugins::install::install_from_dir(&state, &source)
            .expect_err("a directory without a manifest must be rejected");
        assert!(format!("{error:?}").contains("manifest.json"), "{error:?}");
    }

    /// Replacing an installed plugin keeps the old copy until the new one is
    /// in place.
    #[test]
    fn install_replaces_an_existing_plugin() {
        let root = temp_root("install-replace");
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));

        let first = temp_root("install-replace-a");
        write_plugin(&first, "com.example.replace");
        crate::plugins::install::install_from_dir(&state, &first).expect("first install");

        let second = temp_root("install-replace-b");
        write_plugin(&second, "com.example.replace");
        std::fs::write(second.join("extra.js"), "export const v = 2;").expect("write extra");
        crate::plugins::install::install_from_dir(&state, &second).expect("replace");

        let destination = root.join("extensions").join("com.example.replace");
        assert!(
            destination.join("extra.js").is_file(),
            "the replacement's files must be the ones present"
        );
        assert_eq!(state.extensions_catalog().external.len(), 1);
    }

    /// Uninstalling removes the directory, drops the catalog row and forgets
    /// the persisted activation flag.
    #[test]
    fn uninstall_removes_the_directory_and_the_persisted_flag() {
        let root = temp_root("uninstall");
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));

        let source = temp_root("uninstall-src");
        write_plugin(&source, "com.example.gone");
        crate::plugins::install::install_from_dir(&state, &source).expect("install");

        // Persist an explicit flag so we can prove uninstall forgets it.
        state
            .persist_extension_enabled("com.example.gone", false)
            .expect("persist");
        assert_eq!(
            state.persisted_extension_enabled("com.example.gone"),
            Some(false)
        );

        crate::plugins::install::uninstall(&state, "com.example.gone").expect("uninstall");

        assert!(!root.join("extensions").join("com.example.gone").exists());
        assert_eq!(state.extensions_catalog().external.len(), 0);
        assert_eq!(
            state.persisted_extension_enabled("com.example.gone"),
            None,
            "a reinstall must start from the manifest default, not the old choice"
        );
    }

    /// A builtin extension cannot be uninstalled: its code ships with the app.
    #[test]
    fn uninstall_refuses_a_builtin_extension() {
        let root = temp_root("uninstall-builtin");
        let state = std::sync::Arc::new(AppState::new(root).expect("state"));

        let error = crate::plugins::install::uninstall(&state, "eshell.sftp")
            .expect_err("builtin removal must be refused");
        assert!(format!("{error:?}").contains("builtin"), "{error:?}");
        assert!(state.extensions().is_enabled("eshell.sftp"));
    }

    /// An unknown id is a NotFound, not a silent success.
    #[test]
    fn uninstall_reports_an_unknown_extension() {
        let root = temp_root("uninstall-unknown");
        let state = std::sync::Arc::new(AppState::new(root).expect("state"));

        let error = crate::plugins::install::uninstall(&state, "com.example.absent")
            .expect_err("unknown id must be rejected");
        assert!(format!("{error:?}").contains("com.example.absent"), "{error:?}");
    }

    /// A plugin holding a busy lease cannot be uninstalled: deleting its
    /// directory would strand the in-flight operation.
    #[test]
    fn uninstall_refuses_a_busy_plugin() {
        let root = temp_root("uninstall-busy");
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));

        let source = temp_root("uninstall-busy-src");
        write_plugin(&source, "com.example.busy");
        crate::plugins::install::install_from_dir(&state, &source).expect("install");

        let lease = state
            .extensions()
            .lease("com.example.busy")
            .expect("take lease");
        let error = crate::plugins::install::uninstall(&state, "com.example.busy")
            .expect_err("a busy plugin must not be uninstallable");
        assert!(format!("{error:?}").contains("in flight"), "{error:?}");
        assert!(root.join("extensions").join("com.example.busy").exists());

        // Once the lease is released the removal goes through.
        drop(lease);
        crate::plugins::install::uninstall(&state, "com.example.busy").expect("uninstall");
        assert!(!root.join("extensions").join("com.example.busy").exists());
    }

    /// A re-scan must not re-enable a plugin the user turned off, and must
    /// not disturb an untouched one.
    #[test]
    fn rescan_preserves_explicit_activation_flags() {
        let root = temp_root("rescan-flags");
        let state = std::sync::Arc::new(AppState::new(root.clone()).expect("state"));

        let source = temp_root("rescan-flags-src");
        write_plugin(&source, "com.example.flag");
        crate::plugins::install::install_from_dir(&state, &source).expect("install");

        state
            .extensions()
            .set_enabled("com.example.flag", false)
            .expect("disable");
        assert!(!state.extensions().is_enabled("com.example.flag"));

        state.rescan_extensions_catalog().expect("rescan");
        assert!(
            !state.extensions().is_enabled("com.example.flag"),
            "a rescan must not silently re-enable a disabled plugin"
        );
    }
}
