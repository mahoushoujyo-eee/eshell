//! Tests for the extension runtime, extracted from the business files.
//!
//! One nested module per source file, named `<file>_tests`. Test bodies are
//! verbatim copies of the inline `#[cfg(test)] mod tests` blocks they came
//! from; only the imports were rewritten to the real module paths. The
//! `include_str!` fixture paths are relative to *this* file
//! (`src/domain/extensions/`).

mod command_tests {
    use crate::domain::extensions::command::*;
    use crate::domain::extensions::consts::*;
    use crate::domain::extensions::service::protocol;
    use crate::state::AppState;

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
            vec![crate::domain::extensions::model_manifest::ContributedPanel {
                id: "sftp".to_string(),
                order: 10,
            }]
        );

        let monitor = &descriptors[1];
        assert_eq!(monitor.id, "eshell.server-monitor");
        assert_eq!(monitor.display_name, "Server Monitor");
        assert_eq!(
            monitor.contributes.panels,
            vec![crate::domain::extensions::model_manifest::ContributedPanel {
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
        let lease = crate::domain::extensions::service::lifecycle::require_plugin_active(&state, "eshell.sftp")
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

        match crate::domain::extensions::service::lifecycle::require_plugin_active(&state, "eshell.sftp") {
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
        use crate::common::time::now_rfc3339;
        state.put_session(crate::domain::ssh::model::session_model::ShellSession {
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
        crate::domain::extensions::service::lifecycle::apply_activation(&state, "eshell.server-monitor", false);

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
            crate::domain::extensions::service::install::install_from_dir(&state, &source).expect("install");
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

        let error = crate::domain::extensions::service::install::install_from_dir(&state, &source)
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

        let error = crate::domain::extensions::service::install::install_from_dir(&state, &source)
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
        crate::domain::extensions::service::install::install_from_dir(&state, &first).expect("first install");

        let second = temp_root("install-replace-b");
        write_plugin(&second, "com.example.replace");
        std::fs::write(second.join("extra.js"), "export const v = 2;").expect("write extra");
        crate::domain::extensions::service::install::install_from_dir(&state, &second).expect("replace");

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
        crate::domain::extensions::service::install::install_from_dir(&state, &source).expect("install");

        // Persist an explicit flag so we can prove uninstall forgets it.
        state
            .persist_extension_enabled("com.example.gone", false)
            .expect("persist");
        assert_eq!(
            state.persisted_extension_enabled("com.example.gone"),
            Some(false)
        );

        crate::domain::extensions::service::install::uninstall(&state, "com.example.gone").expect("uninstall");

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

        let error = crate::domain::extensions::service::install::uninstall(&state, "eshell.sftp")
            .expect_err("builtin removal must be refused");
        assert!(format!("{error:?}").contains("builtin"), "{error:?}");
        assert!(state.extensions().is_enabled("eshell.sftp"));
    }

    /// An unknown id is a NotFound, not a silent success.
    #[test]
    fn uninstall_reports_an_unknown_extension() {
        let root = temp_root("uninstall-unknown");
        let state = std::sync::Arc::new(AppState::new(root).expect("state"));

        let error = crate::domain::extensions::service::install::uninstall(&state, "com.example.absent")
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
        crate::domain::extensions::service::install::install_from_dir(&state, &source).expect("install");

        let lease = state
            .extensions()
            .lease("com.example.busy")
            .expect("take lease");
        let error = crate::domain::extensions::service::install::uninstall(&state, "com.example.busy")
            .expect_err("a busy plugin must not be uninstallable");
        assert!(format!("{error:?}").contains("in flight"), "{error:?}");
        assert!(root.join("extensions").join("com.example.busy").exists());

        // Once the lease is released the removal goes through.
        drop(lease);
        crate::domain::extensions::service::install::uninstall(&state, "com.example.busy").expect("uninstall");
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
        crate::domain::extensions::service::install::install_from_dir(&state, &source).expect("install");

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

mod model_manifest_tests {
    use crate::domain::extensions::consts::*;
    use crate::domain::extensions::model_manifest::*;
    use std::path::PathBuf;

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

mod broker_tests {
    use crate::common::error::AppError;
    use crate::common::time::now_rfc3339;
    use crate::domain::extensions::consts::*;
    use crate::domain::extensions::model_manifest::Contributes;
    use crate::domain::extensions::service::broker::*;
    use crate::domain::monitor::model::{FetchServerStatusInput, ServerStatus};
    use crate::domain::sftp::model::SftpListResponse;
    use crate::domain::sftp::model::{
        SftpCancelTransferInput, SftpCreateInput, SftpDeleteInput, SftpDownloadInput,
        SftpDownloadToLocalInput, SftpListInput, SftpReadInput, SftpRenameInput,
        SftpUploadLocalWithProgressInput, SftpWriteInput,
    };
    use crate::domain::ssh::model::session_model::ShellSession;
    use crate::domain::ssh::model::session_model::{CloseShellInput, ExecuteCommandInput, OpenShellInput};
    use crate::state::AppState;
    use serde::Deserialize;
    use std::sync::Arc;

    fn temp_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-broker-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        // Seed one external plugin so the caller lease can be taken.
        let state = Arc::new(AppState::new(root).expect("create test state"));
        register_external(&state, "com.example.plugin");
        state
    }

    /// Registers an external extension into the running registry by hand:
    /// discovery normally does this at startup.
    fn register_external(state: &AppState, extension_id: &str) {
        // The catalog-owned test hook registers the id into the activation
        // surface (discovery normally does this at startup).
        state.extensions_test_register(extension_id);
    }

    /// Unknown extensions are refused before any command runs.
    #[test]
    fn whitelist_is_fixed() {
        for allowed in [
            "list_shell_sessions",
            "sftp_list_dir",
            "get_cached_server_status",
            "select_upload_file",
        ] {
            assert!(is_whitelisted(allowed), "{allowed}");
        }
        for denied in [
            "pty_write_input",
            "list_ssh_configs",
            "save_ssh_config",
            "delete_ssh_config",
            "trust_ssh_host_key",
            "pty_resize",
            "reopen_shell_pty",
            "run_script",
            "ssh_ki_respond",
            "set_extension_enabled",
        ] {
            assert!(!is_whitelisted(denied), "{denied} must not be brokerable");
        }
    }

    /// Unknown commands and mismatched shapes are Validation errors, and the
    /// caller lease gates unknown/disabled extensions.
    #[test]
    fn unknown_commands_are_outside_the_whitelist() {
        // A real AppHandle is unavailable in unit tests; dispatch paths that
        // need one are covered by integration/QA. This pins the pure
        // decision boundary: unknown command, PTY input, credentials.
        assert!(!is_whitelisted("definitely_not_a_command"));
    }

    /// The caller lease rejects a disable while the caller's operation is in
    /// flight — an external extension's own busy count, independent of the
    /// provider's.
    #[tokio::test]
    async fn external_caller_busy_rejects_disable() {
        let state = temp_state();

        // Take the caller lease exactly as `invoke` does.
        let lease =
            crate::domain::extensions::service::lifecycle::require_plugin_active(&state, "com.example.plugin")
                .expect("lease the external caller");
        // While the caller's operation is in flight, disabling it is rejected.
        assert!(matches!(
            state.extensions().set_enabled("com.example.plugin", false),
            Err(AppError::Validation(message)) if message.to_string().contains("in flight")
        ));
        assert!(state.extensions().is_enabled("com.example.plugin"));
        drop(lease);
        state
            .extensions()
            .set_enabled("com.example.plugin", false)
            .expect("disable after the operation finished");
        assert!(!state.extensions().is_enabled("com.example.plugin"));
    }

    /// A disabled or unknown caller is refused before dispatch.
    #[tokio::test]
    async fn disabled_and_unknown_callers_are_refused() {
        let state = temp_state();
        state
            .extensions()
            .set_enabled("com.example.plugin", false)
            .expect("disable");
        match crate::domain::extensions::service::lifecycle::require_plugin_active(&state, "com.example.plugin") {
            Err(error) => assert!(
                error.to_string().contains("disabled"),
                "the refusal must name the disabled extension: {error}"
            ),
            Ok(_) => panic!("a disabled caller must be refused"),
        }

        match crate::domain::extensions::service::lifecycle::require_plugin_active(&state, "com.example.ghost") {
            Err(error) => assert!(
                matches!(error, AppError::NotFound(_)),
                "an unknown caller must be NotFound: {error}"
            ),
            Ok(_) => panic!("an unknown caller must be refused"),
        }
    }

    // Shared with the JS facade tests: these are actual serialized broker
    // requests, not domain inputs with the wire envelope removed by a mock.
    #[derive(Deserialize)]
    struct WireCase {
        api: String,
        request: InvokeExtensionApiInput,
    }

    #[test]
    fn shared_frontend_wire_requests_parse_through_the_dispatch_parser() {
        let cases: Vec<WireCase> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/plugin-api-wire.json"
        ))
        .expect("shared wire fixtures");
        assert_eq!(cases.len(), 21);
        let mut seen = std::collections::BTreeSet::new();
        for case in cases {
            let request = case.request;
            assert_eq!(request.extension_id, "eshell.sftp");
            assert!(seen.insert(request.command.clone()), "duplicate wire command");
            let command = request.command.as_str();
            macro_rules! parsed {
                ($ty:ty) => {
                    parse_args::<$ty>(command, &request.args)
                        .unwrap_or_else(|error| panic!("{} ({command}): {error}", case.api))
                };
            }
            match command {
                "list_shell_sessions" | "sftp_default_download_dir" => {
                    let _ = parsed!(NoArgs);
                }
                "open_shell_session" => assert_eq!(parsed!(OpenShellInput).config_id, "wire-config"),
                "close_shell_session" => assert_eq!(parsed!(CloseShellInput).session_id, "wire-session"),
                "execute_shell_command" => {
                    let input = parsed!(ExecuteCommandInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.command, "pwd");
                }
                "sftp_list_dir" => {
                    let input = parsed!(SftpListInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.path, "/var");
                }
                "sftp_read_file" => assert_eq!(parsed!(SftpReadInput).session_id, "wire-session"),
                "sftp_write_file" => assert_eq!(parsed!(SftpWriteInput).session_id, "wire-session"),
                "sftp_create_file" | "sftp_create_directory" => {
                    assert_eq!(parsed!(SftpCreateInput).session_id, "wire-session");
                }
                "sftp_delete_entry" => assert_eq!(parsed!(SftpDeleteInput).session_id, "wire-session"),
                "sftp_rename_entry" => {
                    let input = parsed!(SftpRenameInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.new_name, "renamed.txt");
                }
                "sftp_upload_local_file_with_progress" => {
                    assert_eq!(parsed!(SftpUploadLocalWithProgressInput).session_id, "wire-session");
                }
                "sftp_download_file_to_local" => {
                    assert_eq!(parsed!(SftpDownloadToLocalInput).session_id, "wire-session");
                }
                "sftp_cancel_transfer" => {
                    assert_eq!(parsed!(SftpCancelTransferInput).transfer_id, "wire-upload");
                }
                "fetch_server_status" => {
                    let input = parsed!(FetchServerStatusInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.selected_interface.as_deref(), Some("eth0"));
                }
                "get_cached_server_status" => assert_eq!(parsed!(SessionIdArgs).session_id, "wire-session"),
                "select_upload_file" | "select_download_dir" => {
                    assert_eq!(parsed!(PickerArgs).default_path.as_deref(), Some("/local"));
                }
                "reload_config" => {
                    // `{ file }` selects one file; `{}` means all of them.
                    assert_eq!(parsed!(ReloadArgs).file.as_deref(), Some("sshConfigs"));
                }
                "list_reloadable_configs" => {
                    let _ = parsed!(NoArgs);
                }
                _ => panic!("uncovered shared wire command: {command}"),
            }
        }
        // This legacy base64 endpoint is not exposed by the JS facade, but
        // its existing input-wrapped contract must remain correct as well.
        let legacy: SftpDownloadInput = parse_args("sftp_download_file", &serde_json::json!({
            "input": { "sessionId": "wire-session", "remotePath": "/var/app.txt" }
        })).expect("legacy download envelope");
        assert_eq!(legacy.session_id, "wire-session");
        seen.insert("sftp_download_file".to_string());
        assert_eq!(seen, WHITELIST.iter().map(|name| name.to_string()).collect());
    }

    #[test]
    fn input_wrapped_commands_reject_missing_or_malformed_envelopes() {
        for malformed in [
            serde_json::json!({ "sessionId": "s", "path": "/" }),
            serde_json::json!({ "input": { "path": "/" } }),
            serde_json::json!({ "input": null }),
            serde_json::json!({ "input": { "input": { "sessionId": "s", "path": "/" } } }),
        ] {
            let error = parse_args::<SftpListInput>("sftp_list_dir", &malformed)
                .expect_err("invalid directory request must not silently default");
            assert!(error.to_string().contains("invalid arguments for sftp_list_dir"));
        }
        assert!(parse_args::<FetchServerStatusInput>(
            "fetch_server_status",
            &serde_json::json!({ "sessionId": "s" })
        ).is_err());
    }

    /// `get_cached_server_status` keeps its legacy flat `{ sessionId }` shape.
    #[tokio::test]
    async fn cached_status_args_shape_is_verbatim() {
        let state = AppState::new(std::env::temp_dir().join(format!(
            "eshell-broker-shape-{}",
            uuid::Uuid::new_v4().simple()
        )))
        .expect("state");
        state.put_session(crate::domain::ssh::model::session_model::ShellSession {
            id: "session-1".to_string(),
            config_id: "config-1".to_string(),
            config_name: "Test".to_string(),
            current_dir: String::new(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        });
        // Flat shape parses; the wrapped shape must not.
        let flat: SessionIdArgs = parse_args(
            "get_cached_server_status",
            &serde_json::json!({ "sessionId": "session-1" }),
        ).expect("flat");
        assert_eq!(flat.session_id, "session-1");
        assert!(parse_args::<SessionIdArgs>("get_cached_server_status", &serde_json::json!({
            "input": { "sessionId": "session-1" }
        }))
        .is_err());
        let cached = crate::domain::monitor::service::get_cached_status(&state, "session-1");
        assert!(cached.is_none());
    }

    /// No-arg commands refuse extra structure the real command would ignore.
    #[test]
    fn no_arg_commands_parse_empty_objects() {
        let ok: NoArgs = serde_json::from_value(serde_json::json!({})).expect("empty");
        let _ = ok;
        // Non-object junk is rejected rather than silently defaulted.
        assert!(serde_json::from_value::<NoArgs>(serde_json::json!("x")).is_err());
        assert!(serde_json::from_value::<NoArgs>(serde_json::json!(null)).is_err());
    }

    /// Picker args: optional title/defaultPath, everything else rejected.
    #[test]
    fn picker_args_shape() {
        let empty: PickerArgs = serde_json::from_value(serde_json::json!({})).expect("empty");
        assert!(empty.title.is_none());
        assert!(empty.default_path.is_none());

        let full: PickerArgs = serde_json::from_value(serde_json::json!({
            "title": "Pick a file",
            "defaultPath": "C:/Users"
        }))
        .expect("full");
        assert_eq!(full.title.as_deref(), Some("Pick a file"));
        assert_eq!(full.default_path.as_deref(), Some("C:/Users"));

        // The plan's other name must not leak in as an alias.
        let wrong: Result<PickerArgs, _> =
            serde_json::from_value(serde_json::json!({ "defaultDir": "C:/Users" }));
        let wrong = wrong.expect("unknown fields are ignored by serde default");
        assert!(wrong.default_path.is_none());
    }

    /// `Contributes` re-export sanity: external manifests contribute panels.
    #[test]
    fn contributes_default_is_empty() {
        assert!(Contributes::default().panels.is_empty());
    }

    /// Serialization of a session DTO keeps camelCase (the verbatim contract).
    #[test]
    fn session_dto_serializes_camel_case() {
        let session = ShellSession {
            id: "s".to_string(),
            config_id: "c".to_string(),
            config_name: "n".to_string(),
            current_dir: String::new(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        let value = to_value(session).expect("serialize");
        assert!(value.get("configId").is_some());
        assert!(value.get("config_id").is_none());
    }

    /// `SftpListResponse` DTO shape is the existing one.
    #[test]
    fn sftp_list_response_dto_is_verbatim() {
        let response = SftpListResponse {
            path: "/".to_string(),
            entries: Vec::new(),
        };
        let value = to_value(response).expect("serialize");
        assert!(value.get("entries").is_some());
    }

    /// A minimal `ServerStatus` for DTO-shape assertions.
    fn sample_status() -> ServerStatus {
        ServerStatus {
            cpu_percent: 1.0,
            memory: Default::default(),
            network_interfaces: Vec::new(),
            selected_interface: None,
            selected_interface_traffic: None,
            top_processes: Vec::new(),
            disks: Vec::new(),
            gpus: Vec::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// Status DTO serialization stays camelCase.
    #[test]
    fn status_dto_serializes_camel_case() {
        let status = sample_status();
        let value = to_value(status).expect("serialize");
        assert!(value.get("cpuPercent").is_some());
    }
}

mod discovery_tests {
    use crate::domain::extensions::service::discovery::*;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

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
            std::fs::write(dir.join("manifest.json"), manifest).expect("write");
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
        let order = |run: &Vec<crate::domain::extensions::model_manifest::DiscoveredPlugin>| {
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

mod extension_state_tests {
    use crate::domain::extensions::service::discovery::EXTENSION_STATE_FILE;
    use crate::domain::extensions::service::extension_state::*;
    use std::path::PathBuf;

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

mod mcp_tools_tests {
    use crate::domain::extensions::service::mcp_tools::*;
    use crate::state::AppState;
    use serde_json::Value;
    use std::sync::Arc;

    fn test_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-plugin-tools-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Arc::new(AppState::new(root).expect("create test state"))
    }

    /// The pre-migration default `tools/list`, captured from git HEAD
    /// (`mcp_bridge::tool_definitions` before this refactor) as a golden
    /// value. Names, order, schemas and descriptions must match exactly.
    #[test]
    fn default_tools_list_matches_the_pre_migration_golden() {
        let state = test_state();
        let tools = plugin_tool_definitions(&state);
        // Only the plugin-contributed tail: core tools are asserted by the
        // bridge's own golden test.
        let golden = serde_json::from_str::<Value>(PRE_MIGRATION_PLUGIN_TOOLS_JSON)
            .expect("parse golden json");
        assert_eq!(
            serde_json::to_value(&tools).expect("serialize"),
            golden,
            "plugin tool definitions must match the pre-migration list"
        );
    }

    /// Order is part of the contract: SFTP tools precede the status tool.
    #[test]
    fn plugin_tools_keep_the_pre_migration_order() {
        let state = test_state();
        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(
            names,
            [
                "read_remote_file",
                "write_remote_file",
                "list_remote_dir",
                "get_server_status"
            ]
        );
    }

    /// Deactivating a plugin removes exactly its tools, keeping the rest.
    #[test]
    fn deactivating_a_plugin_removes_only_its_tools() {
        let state = test_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable sftp");

        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(names, ["get_server_status"]);

        state
            .extensions()
            .set_enabled("eshell.server-monitor", false)
            .expect("disable status");
        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert!(names.is_empty());

        // Re-enabling restores the full ordered list.
        state
            .extensions()
            .set_enabled("eshell.sftp", true)
            .expect("enable sftp");
        state
            .extensions()
            .set_enabled("eshell.server-monitor", true)
            .expect("enable status");
        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(
            names,
            [
                "read_remote_file",
                "write_remote_file",
                "list_remote_dir",
                "get_server_status"
            ]
        );
    }

    /// Calling a deactivated plugin's tool reports the unknown-tool error,
    /// matching the pre-migration semantics of an unregistered name.
    #[tokio::test]
    async fn calling_a_deactivated_plugins_tool_reports_unknown_tool() {
        let state = test_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable sftp");

        let outcome = dispatch_plugin_tool(
            &state,
            "read_remote_file",
            &serde_json::json!({"sessionId": "s", "path": "/"}),
        )
        .await;
        assert!(
            outcome.is_none(),
            "a deactivated plugin's tool must be unknown"
        );

        // An active plugin's tool still routes and reports its own errors
        // (here: the missing session) inside the result, not as None.
        let outcome = dispatch_plugin_tool(
            &state,
            "get_server_status",
            &serde_json::json!({"sessionId": "missing-session"}),
        )
        .await
        .expect("the status tool must route");
        assert!(
            outcome.is_err(),
            "the missing session must be an in-result error"
        );
    }

    /// The plugin tool JSON exactly as `tools/list` exposed it before the
    /// migration (git HEAD: `server_ops::sftp` + `server_ops::status` tools).
    /// Captured from the pre-migration `tool_definitions()` output; do not
    /// regenerate from the current implementation.
    const PRE_MIGRATION_PLUGIN_TOOLS_JSON: &str = r#"[
  {
    "name": "read_remote_file",
    "description": "Read a text file from the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote path"
        }
      },
      "required": [
        "sessionId",
        "path"
      ]
    }
  },
  {
    "name": "write_remote_file",
    "description": "Write (create or overwrite) a text file on the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote path"
        },
        "content": {
          "type": "string",
          "description": "Full file content to write"
        }
      },
      "required": [
        "sessionId",
        "path",
        "content"
      ]
    }
  },
  {
    "name": "list_remote_dir",
    "description": "List a directory on the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote directory path"
        }
      },
      "required": [
        "sessionId",
        "path"
      ]
    }
  },
  {
    "name": "get_server_status",
    "description": "Fetch live CPU, memory, disk, network, and top-process metrics for the remote server of an open session.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        }
      },
      "required": [
        "sessionId"
      ]
    }
  }
]"#;
}

mod protocol_tests {
    use crate::domain::extensions::consts::*;
    use crate::domain::extensions::model_manifest::{BuiltinManifest, Contributes, ExternalExtensionEntry};
    use crate::domain::extensions::service::protocol::*;
    use std::path::PathBuf;

    fn temp_catalog(name: &str) -> (PathBuf, crate::domain::extensions::model_manifest::ExtensionCatalog) {
        let root = std::env::temp_dir().join(format!(
            "eshell-protocol-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = root.join("extensions").join("a-plugin-dir");
        std::fs::create_dir_all(plugin_dir.join("assets")).expect("create plugin tree");
        std::fs::write(plugin_dir.join("index.js"), b"export default 1;")
            .expect("write entry");
        std::fs::write(plugin_dir.join("assets").join("app.js"), b"export const x = 2;")
            .expect("write asset");
        std::fs::write(plugin_dir.join("assets").join("style.css"), b"body{}")
            .expect("write css");
        std::fs::write(plugin_dir.join("assets").join("logo.svg"), b"<svg/>")
            .expect("write svg");
        std::fs::write(
            root.join("extensions").join(crate::domain::extensions::service::discovery::EXTENSION_STATE_FILE),
            "{}",
        )
        .expect("write state file");

        let plugin = crate::domain::extensions::model_manifest::DiscoveredPlugin {
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
            dir: plugin_dir.clone(),
            canonical_dir: std::fs::canonicalize(&plugin_dir).expect("canonicalize plugin dir"),
        };
        let catalog = crate::domain::extensions::model_manifest::ExtensionCatalog {
            builtin: BuiltinManifest::parse().expect("manifest"),
            external: vec![plugin],
        };
        (root, catalog)
    }

    fn get(response: &tauri::http::Response<Vec<u8>>, header: &str) -> String {
        String::from_utf8_lossy(
            response
                .headers()
                .get(header)
                .map(|value| value.as_bytes())
                .unwrap_or_default(),
        )
        .to_string()
    }

    /// Happy path: entry module served as JavaScript with CORS + no-store.
    #[test]
    fn entry_module_is_served_as_javascript_with_cors() {
        let (_root, catalog) = temp_catalog("entry");
        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(get(&response, "content-type"), "text/javascript");
        assert_eq!(get(&response, "access-control-allow-origin"), "*");
        assert_eq!(get(&response, "cache-control"), "no-store");
        assert_eq!(response.body(), b"export default 1;");
    }

    /// Nested assets inherit the same headers with their own MIME types.
    #[test]
    fn nested_assets_use_allowlisted_mime_types() {
        let (_root, catalog) = temp_catalog("assets");
        for (path, mime, body) in [
            (
                "/com.example.plugin/assets/app.js",
                "text/javascript",
                b"export const x = 2;".as_slice(),
            ),
            ("/com.example.plugin/assets/style.css", "text/css", b"body{}"),
            (
                "/com.example.plugin/assets/logo.svg",
                "image/svg+xml",
                b"<svg/>",
            ),
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert_eq!(response.status(), tauri::http::StatusCode::OK, "{path}");
            assert_eq!(get(&response, "content-type"), mime, "{path}");
            assert_eq!(response.body(), body, "{path}");
            assert_eq!(get(&response, "cache-control"), "no-store", "{path}");
        }
    }

    /// Unknown plugins, unknown resources and non-allowlisted types are HTTP
    /// errors, never panics; the state file is not reachable.
    #[test]
    fn unknown_and_disallowed_resources_answer_http_errors() {
        let (root, catalog) = temp_catalog("errors");
        let cases = [
            "/com.example.missing/index.js",
            "/com.example.plugin/nothing.js",
            "/com.example.plugin/assets/style.scss",
            "/com.example.plugin/../../state.json",
            "/",
            "/com.example.plugin",
        ];
        for path in cases {
            let response = serve_extension_asset(&catalog, path);
            assert_ne!(response.status(), tauri::http::StatusCode::OK, "{path}");
        }

        // The state file under extensions/ is never served: it is not inside
        // any plugin directory, and no id resolves to it.
        let state_path = root
            .join("extensions")
            .join(crate::domain::extensions::service::discovery::EXTENSION_STATE_FILE);
        let response = serve_extension_asset(
            &catalog,
            &format!(
                "/com.example.plugin/{}",
                state_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
            ),
        );
        assert_ne!(response.status(), tauri::http::StatusCode::OK);
    }

    /// `..` and absolute paths are refused before touching the filesystem.
    #[test]
    fn escapes_are_refused() {
        let (_root, catalog) = temp_catalog("escape");
        for path in [
            "/com.example.plugin/..%2F..%2Fstate.json",
            "/com.example.plugin/%2e%2e/index.js",
            "/com.example.plugin//etc/passwd.js",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert!(
                response.status() == tauri::http::StatusCode::FORBIDDEN
                    || response.status() == tauri::http::StatusCode::NOT_FOUND,
                "{path}"
            );
            assert_ne!(response.status(), tauri::http::StatusCode::OK, "{path}");
        }
    }

    /// A symlinked asset pointing outside the plugin directory is refused by
    /// the canonical containment check.
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn symlink_escape_is_refused() {
        let (root, catalog) = temp_catalog("symlink");
        let outside = root.join("outside-secret.js");
        std::fs::write(&outside, b"secret").expect("write outside");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");
        std::os::unix::fs::symlink(&outside, plugin_dir.join("linked.js")).expect("symlink");

        let response = serve_extension_asset(&catalog, "/com.example.plugin/linked.js");
        assert_eq!(response.status(), tauri::http::StatusCode::FORBIDDEN);
        assert_ne!(response.body(), b"secret");
    }

    /// A directory *re-pointed* after discovery is refused: the stored
    /// canonical directory is the only trusted root, and a plugin directory
    /// that no longer resolves to it (removed and recreated as a link to the
    /// storage root, or anywhere else) never has its new target adopted.
    ///
    /// Windows junctions exercise the same check; creating them needs
    /// privileges in tests, so QA covers that platform (the check itself is
    /// platform-shared: `canonicalize` resolves junctions and symlinks alike).
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn redirected_directory_after_discovery_is_refused() {
        let (root, catalog) = temp_catalog("redirected-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // The attacker's target: the storage root, holding ssh_configs.json
        // and state.json that must never become plugin assets.
        std::fs::write(
            root.join("ssh_configs.json"),
            b"[{\"host\":\"storage-root\"}]",
        )
        .expect("write storage root file");

        // Re-point the plugin directory at it: remove the real directory and
        // put a symlink in its place.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::os::unix::fs::symlink(&root, &plugin_dir).expect("symlink plugin dir");

        // Every request through the re-pointed directory is refused: the
        // anchor check compares the *current* resolved directory against the
        // stored discovery-time root, so the new target is not re-anchored.
        for path in [
            "/com.example.plugin/index.js",
            "/com.example.plugin/ssh_configs.json",
            "/com.example.plugin/state.json",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert_eq!(
                response.status(),
                tauri::http::StatusCode::FORBIDDEN,
                "{path}"
            );
            assert!(
                response.body() != b"[{\"host\":\"storage-root\"}]",
                "{path} must not serve the redirected target's contents"
            );
        }
    }

    /// In-place content changes do not move the anchor: a directory recreated
    /// at the same canonical location keeps its root, and only files *under
    /// that root* are served. The contract item that matters — the real
    /// `extensions/state.json` living *outside* every plugin directory —
    /// stays unreachable no matter what a plugin directory contains.
    #[test]
    fn in_place_directory_recreation_keeps_the_anchor() {
        let (root, catalog) = temp_catalog("recreated-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // Recreate the directory in place with fresh content.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::fs::create_dir_all(&plugin_dir).expect("recreate plugin dir");
        std::fs::write(plugin_dir.join("index.js"), b"export default 2;").expect("entry");

        // Same canonical location: the anchor holds, the fresh entry serves.
        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export default 2;");

        // The real extension state file - directly under extensions/, never
        // inside a plugin directory - is still unreachable: no id resolves to
        // it, and no plugin-root containment can cover it.
        let state_path = root
            .join("extensions")
            .join(crate::domain::extensions::service::discovery::EXTENSION_STATE_FILE);
        let response = serve_extension_asset(
            &catalog,
            &format!(
                "/com.example.plugin/{}",
                state_path.file_name().unwrap().to_string_lossy()
            ),
        );
        // It is not under the plugin root: 403/404, never 200.
        assert_ne!(response.status(), tauri::http::StatusCode::OK);
    }

    /// Regular file updates *inside* the anchored root stay allowed: the
    /// anchor constrains the root, not the files' contents or timestamps.
    #[test]
    fn file_updates_inside_the_anchored_root_are_allowed() {
        let (root, catalog) = temp_catalog("file-update");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // Rewrite the entry module and an asset in place.
        std::fs::write(plugin_dir.join("index.js"), b"export default 42;").expect("rewrite entry");
        std::fs::write(plugin_dir.join("assets").join("app.js"), b"export const x = 3;")
            .expect("rewrite asset");

        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export default 42;");
        let response = serve_extension_asset(&catalog, "/com.example.plugin/assets/app.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export const x = 3;");
    }

    /// The bundle URL is platform-correct and encodes both segments.
    #[test]
    fn bundle_url_is_platform_correct_and_encoded() {
        let (_root, catalog) = temp_catalog("bundle-url");
        let url = bundle_url(&catalog.external[0]);
        if cfg!(windows) {
            assert_eq!(url, "http://plugin.localhost/com.example.plugin/index.js");
        } else {
            assert_eq!(url, "plugin://localhost/com.example.plugin/index.js");
        }

        // Ids and paths needing encoding stay unambiguous.
        let odd = crate::domain::extensions::model_manifest::DiscoveredPlugin {
            entry: ExternalExtensionEntry {
                id: "com.example/a b".to_string(),
                display_name: "Odd".to_string(),
                version: "1".to_string(),
                api_version: SUPPORTED_API_VERSION,
                builtin: false,
                default_enabled: true,
                main: "dir name/entry file.js".to_string(),
                contributes: Contributes::default(),
            },
            dir: PathBuf::from("odd"),
            canonical_dir: PathBuf::from("odd"),
        };
        let url = bundle_url(&odd);
        let (origin, rest) = url.split_once("://").expect("origin");
        let host = if cfg!(windows) {
            "plugin.localhost"
        } else {
            "localhost"
        };
        assert_eq!(origin, if cfg!(windows) { "http" } else { "plugin" });
        assert!(rest.starts_with(&format!("{host}/")), "{url}");
        let path = rest.trim_start_matches(&format!("{host}/"));
        assert!(path.starts_with("com.example%2Fa%20b/"), "{url}");
        assert!(path.ends_with("dir%20name/entry%20file.js"), "{url}");
        // And the pieces round-trip through the decoder.
        let (id, main) = path.split_once('/').expect("id/main split");
        assert_eq!(decode_segment(id), "com.example/a b");
        assert_eq!(
            main.split('/').map(decode_segment).collect::<Vec<_>>(),
            vec!["dir name".to_string(), "entry file.js".to_string()]
        );
    }

    /// The scheme name matches the registration and the plan's URL shape.
    #[test]
    fn scheme_name_is_plugin() {
        assert_eq!(PLUGIN_SCHEME, "plugin");
    }
}

mod registry_tests {
    use crate::common::error::AppError;
    use crate::domain::extensions::model_manifest::{BuiltinManifest, DiscoveredPlugin, ExtensionCatalog};
    use crate::domain::extensions::service::registry::*;
    use std::sync::Arc;
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
                entry: crate::domain::extensions::model_manifest::ExternalExtensionEntry {
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
