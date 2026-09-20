//! Tests for the SFTP domain, moved out of the business files.
//!
//! `ops_tests` covers the private helpers of `service/ops.rs` (path
//! normalization, the atomic-write fallback, cancellation races and the
//! progress throttle); `plugin_state_tests` covers the plugin state and
//! active-guard plumbing of `service/mod.rs`.

mod ops_tests {
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use russh_sftp::protocol::FileType;
    use tokio_util::sync::CancellationToken;

    use crate::common::error::AppError;
    use crate::domain::sftp::model::SftpEntryType;
    use crate::domain::sftp::service::ops::*;

    #[test]
    fn transfer_progress_throttle_skips_events_until_interval_elapsed() {
        let mut throttle = TransferProgressThrottle::new(Duration::from_millis(200));
        let started_at = Instant::now();

        assert!(throttle.should_emit(started_at, false));
        assert!(!throttle.should_emit(started_at + Duration::from_millis(199), false));
        assert!(throttle.should_emit(started_at + Duration::from_millis(200), false));
    }

    #[test]
    fn transfer_progress_throttle_allows_forced_final_event() {
        let mut throttle = TransferProgressThrottle::new(Duration::from_millis(200));
        let started_at = Instant::now();

        assert!(throttle.should_emit(started_at, false));
        assert!(throttle.should_emit(started_at + Duration::from_millis(1), true));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn finish_atomic_write_falls_back_to_direct_target_write_when_rename_fails() {
        let renamed = Cell::new(false);
        let direct_written = Cell::new(false);
        let temp_unlinked = Cell::new(false);
        let mut events = Vec::<String>::new();

        finish_atomic_write_with_fallback(
            async {
                renamed.set(true);
                Err(AppError::Runtime("rename rejected".to_string()))
            },
            async {
                direct_written.set(true);
                Ok(())
            },
            async {
                temp_unlinked.set(true);
                Ok(())
            },
            |event, _detail| events.push(event.to_string()),
            "/root/learn_k8s/nginx-deployment.yaml",
            "/root/learn_k8s/.nginx-deployment.yaml.eshell-tmp-test",
        )
        .await
        .expect("fallback save should succeed");

        assert!(renamed.get());
        assert!(direct_written.get());
        assert!(temp_unlinked.get());
        assert_eq!(
            events,
            vec![
                "sftp.write_file.rename_failed",
                "sftp.write_file.direct_write_fallback_succeeded"
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn finish_atomic_write_keeps_rename_success_without_fallback() {
        let direct_written = Cell::new(false);
        let temp_unlinked = Cell::new(false);
        let mut events = Vec::<String>::new();

        finish_atomic_write_with_fallback(
            async { Ok(()) },
            async {
                direct_written.set(true);
                Ok(())
            },
            async {
                temp_unlinked.set(true);
                Ok(())
            },
            |event, _detail| events.push(event.to_string()),
            "/root/config.toml",
            "/root/.config.toml.eshell-tmp-test",
        )
        .await
        .expect("atomic rename should succeed");

        assert!(!direct_written.get());
        assert!(!temp_unlinked.get());
        assert!(events.is_empty());
    }

    #[test]
    fn atomic_write_temp_path_stays_next_to_target_file() {
        let temp_path = atomic_write_temp_path_with_suffix("/var/www/app/config.toml", "abc123");

        assert_eq!(temp_path, "/var/www/app/.config.toml.eshell-tmp-abc123");
    }

    #[test]
    fn renamed_remote_path_stays_in_original_parent_directory() {
        let renamed = renamed_remote_path("/var/www/app/config.toml", "settings.toml")
            .expect("build rename path");

        assert_eq!(renamed, "/var/www/app/settings.toml");
    }

    #[test]
    fn renamed_remote_path_rejects_root_and_nested_names() {
        assert!(renamed_remote_path("/", "root").is_err());
        assert!(renamed_remote_path("/var/www/app/config.toml", "../settings.toml").is_err());
        assert!(renamed_remote_path("/var/www/app/config.toml", "nested/settings.toml").is_err());
    }

    #[test]
    fn normalize_remote_path_repairs_and_keeps_absolute_paths() {
        assert_eq!(normalize_remote_path(""), "/");
        assert_eq!(normalize_remote_path("   "), "/");
        assert_eq!(normalize_remote_path("var/www"), "/var/www");
        assert_eq!(normalize_remote_path("/var//www/"), "/var/www");
        assert_eq!(normalize_remote_path("\\var\\www\\"), "/var/www");
        assert_eq!(normalize_remote_path("/"), "/");
    }

    #[test]
    fn join_remote_path_handles_root_and_trailing_separators() {
        assert_eq!(join_remote_path("/", "file.txt"), "/file.txt");
        assert_eq!(
            join_remote_path("/var/www", "file.txt"),
            "/var/www/file.txt"
        );
        assert_eq!(
            join_remote_path("/var/www/", "/file.txt"),
            "/var/www/file.txt"
        );
    }

    #[test]
    fn entry_type_from_file_type_maps_every_variant() {
        assert_eq!(
            entry_type_from_file_type(FileType::Dir),
            SftpEntryType::Directory
        );
        assert_eq!(
            entry_type_from_file_type(FileType::File),
            SftpEntryType::File
        );
        assert_eq!(
            entry_type_from_file_type(FileType::Symlink),
            SftpEntryType::Symlink
        );
        assert_eq!(
            entry_type_from_file_type(FileType::Other),
            SftpEntryType::Other
        );
    }

    #[test]
    fn compute_transfer_percent_handles_missing_and_zero_totals() {
        assert_eq!(compute_transfer_percent(10, None), 0.0);
        assert_eq!(compute_transfer_percent(10, Some(0)), 0.0);
        assert_eq!(compute_transfer_percent(50, Some(100)), 50.0);
        assert_eq!(compute_transfer_percent(200, Some(100)), 100.0);
    }

    #[test]
    fn extract_remote_file_name_falls_back_for_trailing_separator() {
        assert_eq!(extract_remote_file_name("/var/www/file.txt"), "file.txt");
        assert_eq!(extract_remote_file_name("/"), "download.bin");
    }

    #[test]
    fn normalize_local_dir_rejects_blank_and_trims() {
        assert!(normalize_local_dir("  ").is_err());
        assert_eq!(
            normalize_local_dir("  /tmp/out  ").expect("valid dir"),
            PathBuf::from("/tmp/out")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_cancel_aborts_pending_work_when_transfer_token_fires() {
        let token = CancellationToken::new();
        token.cancel();

        let result = race_cancel(Some(&token), None, std::future::pending::<u8>()).await;

        assert!(result.is_err(), "pre-cancelled transfer must abort");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_cancel_aborts_pending_work_when_session_token_fires() {
        let session = CancellationToken::new();
        session.cancel();

        let result = race_cancel(None, Some(&session), std::future::pending::<u8>()).await;

        assert!(result.is_err(), "closed session must abort the operation");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_cancel_returns_value_when_work_finishes_first() {
        let transfer = CancellationToken::new();
        let session = CancellationToken::new();

        let result = race_cancel(Some(&transfer), Some(&session), async { 7_u8 }).await;

        assert_eq!(result.expect("work should finish first"), 7);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_cancel_observes_cancellation_while_work_is_in_flight() {
        let token = CancellationToken::new();
        let canceller = token.clone();

        let work = async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            1_u8
        };
        let racing = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            canceller.cancel();
        };

        let result = tokio::join!(race_cancel(Some(&token), None, work), racing);

        assert!(result.0.is_err(), "in-flight work must be interrupted");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn inspect_local_upload_source_returns_name_and_size_for_file() {
        let root = unique_temp_dir("local-upload-source");
        tokio::fs::create_dir_all(&root)
            .await
            .expect("create temp dir");
        let file_path = root.join("hello.txt");
        tokio::fs::write(&file_path, b"hello world")
            .await
            .expect("write temp file");

        let source = inspect_local_upload_source(&file_path)
            .await
            .expect("inspect local file");

        assert_eq!(source.file_name, "hello.txt");
        assert_eq!(source.total_bytes, 11);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn inspect_local_upload_source_rejects_directories() {
        let root = unique_temp_dir("local-upload-dir");
        tokio::fs::create_dir_all(&root)
            .await
            .expect("create temp dir");

        let error = inspect_local_upload_source(&root)
            .await
            .expect_err("directory should fail");

        assert!(error.to_string().contains("not a regular file"));
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("eshell-sftp-{name}-{nonce}"))
    }
}

mod plugin_state_tests {
    use std::sync::Arc;

    use crate::domain::sftp::service::ops;
    use crate::domain::sftp::service::{is_active, require_active, EXTENSION_ID};
    use crate::state::AppState;

    fn temp_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-sftp-plugin-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Arc::new(AppState::new(root).expect("create test state"))
    }

    /// The pre-cancel contract moved with the registry: a cancel that arrives
    /// before the transfer begins must be observed, not lost.
    #[test]
    fn transfer_cancellation_preserves_pre_cancel() {
        let state = temp_state();
        let plugin = &state.sftp_plugin().state;

        let active = plugin.begin_transfer("transfer-1");
        assert!(!active.is_cancelled());
        assert!(!plugin.is_transfer_cancelled("transfer-1"));

        assert!(plugin.cancel_transfer("transfer-1"));
        assert!(active.is_cancelled());
        assert!(plugin.is_transfer_cancelled("transfer-1"));

        plugin.clear_transfer("transfer-1");
        assert!(!plugin.is_transfer_cancelled("transfer-1"));

        assert!(!plugin.cancel_transfer("transfer-2"));
        let pre = plugin.begin_transfer("transfer-2");
        assert!(pre.is_cancelled());
        assert!(plugin.is_transfer_cancelled("transfer-2"));
    }

    /// The user-visible cancellation error strings must not drift.
    #[test]
    fn cancellation_error_strings_are_preserved() {
        assert_eq!(
            ops::SFTP_TRANSFER_CANCELLED_MESSAGE,
            "transfer cancelled by user"
        );
        assert_eq!(
            ops::SFTP_OPERATION_CANCELLED_MESSAGE,
            "SFTP operation cancelled by user"
        );
    }

    /// Deactivating cancels outstanding markers and clears the registry,
    /// without touching activation or SSH sessions.
    #[test]
    fn deactivate_cancels_outstanding_markers_and_clears_state() {
        let state = temp_state();
        let plugin = &state.sftp_plugin().state;
        let token = plugin.begin_transfer("transfer-1");
        assert!(!token.is_cancelled());

        plugin.deactivate();
        assert!(token.is_cancelled(), "outstanding marker must be cancelled");
        assert!(!plugin.is_transfer_cancelled("transfer-1"));
    }

    /// The busy lease must cover the real worker, not just the call that
    /// started it: while an operation is in flight (guard held), disabling
    /// the extension is rejected; once the worker finishes or cleans up, the
    /// disable goes through.
    #[tokio::test]
    async fn lease_covers_the_worker_until_it_finishes() {
        let state = temp_state();

        // An operation starts: the guard is taken before any work, exactly as
        // every op in `ops.rs` does.
        let guard = require_active(&state).expect("active extension");

        // While the worker runs, a disable must be rejected.
        assert!(matches!(
            state.extensions().set_enabled(EXTENSION_ID, false),
            Err(crate::common::error::AppError::Validation(_))
        ));
        assert!(is_active(&state));

        // The worker ends (success, failure or cancel cleanup): the guard
        // drops with it, and the disable now succeeds.
        drop(guard);
        state
            .extensions()
            .set_enabled(EXTENSION_ID, false)
            .expect("disable after the worker finished");
        assert!(!is_active(&state));
    }

    /// A pre-cancel placeholder must not leave the extension permanently
    /// busy: the transfer guard clears it on drop, and the busy counter is
    /// only ever held by a live operation guard.
    #[tokio::test]
    async fn pre_cancel_placeholder_does_not_leave_the_extension_busy() {
        let state = temp_state();

        // A cancel arrives before the transfer begins: the plugin records a
        // pre-cancelled marker, exactly as before the migration.
        assert!(!state.sftp_plugin().state.cancel_transfer("transfer-x"));

        // No operation is running, so a disable must not be blocked by the
        // orphan placeholder.
        state
            .extensions()
            .set_enabled(EXTENSION_ID, false)
            .expect("disable with only a pre-cancel placeholder");

        // And the placeholder itself is cancellable/queryable as before.
        let token = state.sftp_plugin().state.begin_transfer("transfer-x");
        assert!(token.is_cancelled(), "the pre-cancel must be observed");
        state.sftp_plugin().state.clear_transfer("transfer-x");
        assert!(
            !state
                .sftp_plugin()
                .state
                .is_transfer_cancelled("transfer-x"),
            "guard drop must clear the placeholder"
        );
    }

    /// The ops themselves fail closed on a deactivated extension: no wire
    /// traffic, no plugin state writes.
    #[tokio::test]
    async fn operations_fail_closed_when_the_extension_is_disabled() {
        let state = temp_state();
        state
            .extensions()
            .set_enabled(EXTENSION_ID, false)
            .expect("disable");

        let error = ops::sftp_list_dir(
            &state,
            None,
            crate::domain::sftp::model::SftpListInput {
                session_id: "session-1".to_string(),
                path: "/".to_string(),
            },
        )
        .await
        .expect_err("a disabled extension must refuse the call");
        assert!(
            error.to_string().contains("disabled"),
            "the error must name the disabled extension: {error}"
        );
    }
}
