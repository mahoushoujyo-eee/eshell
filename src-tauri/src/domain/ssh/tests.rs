//! Unit tests for the SSH domain, split out of the business modules.
//!
//! Each nested module holds the tests that used to live inline in the corresponding
//! `service` file (`error.rs`, `pty.rs`, `session.rs`, `transport.rs`); the test bodies are
//! unchanged, only `use super::*;` was replaced with explicit imports. The loopback
//! integration tests stay separate in `service::integration_tests` / `service::test_support`.

mod error_tests {
    use crate::common::error::AppError;
    use crate::domain::ssh::consts::SSH_HOST_KEY_TRUST_REQUIRED_PREFIX;
    use crate::domain::ssh::model::{SshHostKeyTrustChallenge, SshHostKeyTrustReason};
    use crate::domain::ssh::service::error::{host_key_trust_required, is_stale_connection_error};

    fn challenge() -> SshHostKeyTrustChallenge {
        SshHostKeyTrustChallenge {
            reason: SshHostKeyTrustReason::Unknown,
            host: "example.invalid".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:test".to_string(),
            trusted_fingerprint: None,
        }
    }

    /// `AppError::Runtime` renders as `runtime error: <message>`, so tests (and the frontend) match
    /// the prefix as a substring rather than at the very start of the rendered string.
    fn trust_payload(error: &AppError) -> String {
        let rendered = error.to_string();
        rendered
            .split_once(SSH_HOST_KEY_TRUST_REQUIRED_PREFIX)
            .map(|(_, payload)| payload.to_string())
            .expect("must carry the trust prefix")
    }

    /// The frontend matches the exact prefix and parses the JSON payload after it.
    #[test]
    fn host_key_trust_required_keeps_prefix_and_payload() {
        let error = host_key_trust_required(challenge());

        let payload = trust_payload(&error);
        let parsed: SshHostKeyTrustChallenge =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed.host, "example.invalid");
        assert_eq!(parsed.port, 22);
    }

    /// An administratively refused channel leaves the transport healthy; evicting it here is what
    /// would kill a working PTY / SFTP session.
    #[test]
    fn channel_open_failure_is_not_stale() {
        for reason in [
            russh::ChannelOpenFailure::AdministrativelyProhibited,
            russh::ChannelOpenFailure::ResourceShortage,
            russh::ChannelOpenFailure::ConnectFailed,
        ] {
            let error = AppError::SshTransport(russh::Error::ChannelOpenFailure(reason));
            assert!(
                !is_stale_connection_error(&error),
                "ChannelOpenFailure must not evict a healthy connection"
            );
        }
    }

    #[test]
    fn dead_transports_are_stale() {
        for error in [
            russh::Error::HUP,
            russh::Error::Disconnect,
            russh::Error::SendError,
            russh::Error::ConnectionTimeout,
            russh::Error::KeepaliveTimeout,
            russh::Error::InactivityTimeout,
            russh::Error::IO(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "reset",
            )),
        ] {
            let error = AppError::SshTransport(error);
            assert!(
                is_stale_connection_error(&error),
                "{error:?} should be stale"
            );
        }
    }

    #[test]
    fn remote_policy_and_algorithm_errors_are_not_stale() {
        for error in [
            russh::Error::RequestDenied,
            russh::Error::NotAuthenticated,
            russh::Error::UnknownKey,
            russh::Error::NoCommonAlgo {
                kind: russh::AlgorithmKind::Kex,
                ours: vec!["curve25519-sha256".to_string()],
                theirs: vec!["diffie-hellman-group14-sha1".to_string()],
            },
        ] {
            let error = AppError::SshTransport(error);
            assert!(
                !is_stale_connection_error(&error),
                "{error:?} should not be stale"
            );
        }

        assert!(!is_stale_connection_error(&AppError::Validation(
            "bad input".to_string()
        )));
    }

    #[test]
    fn io_and_sftp_transport_errors_are_stale() {
        assert!(is_stale_connection_error(&AppError::Io(
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broken pipe")
        )));

        assert!(is_stale_connection_error(&AppError::Sftp(
            russh_sftp::client::error::Error::Timeout
        )));
        assert!(!is_stale_connection_error(&AppError::Sftp(
            russh_sftp::client::error::Error::UnexpectedPacket
        )));
    }
}

mod pty_tests {
    use tokio::sync::mpsc;

    use crate::domain::ssh::service::pty::*;
    use crate::state::PtyCommand;

    #[test]
    fn drain_pty_command_batch_respects_limit_and_keeps_order() {
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyCommand>();
        tx.send(PtyCommand::Input("aa".to_string()))
            .expect("send input");
        tx.send(PtyCommand::Resize {
            cols: 120,
            rows: 40,
        })
        .expect("send resize");
        tx.send(PtyCommand::Input("bb".to_string()))
            .expect("send input");
        let first = drain_pty_command_batch(&mut rx, 2);
        assert_eq!(first.drained_messages, 2);
        assert_eq!(first.input, b"aa");
        assert_eq!(first.latest_resize, Some((120, 40)));
        assert!(!first.close_requested);
        let second = drain_pty_command_batch(&mut rx, 2);
        assert_eq!(second.drained_messages, 1);
        assert_eq!(second.input, b"bb");
        assert_eq!(second.latest_resize, None);
        assert!(!second.close_requested);
    }

    #[test]
    fn drain_pty_command_batch_stops_on_close() {
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyCommand>();
        tx.send(PtyCommand::Input("before".to_string()))
            .expect("send input");
        tx.send(PtyCommand::Close).expect("send close");
        tx.send(PtyCommand::Input("after".to_string()))
            .expect("send input");
        let batch = drain_pty_command_batch(&mut rx, 10);
        assert!(batch.close_requested);
        assert_eq!(batch.input, b"before");
        assert_eq!(batch.drained_messages, 2);
    }

    #[test]
    fn compact_pending_input_drops_consumed_prefix_when_large_enough() {
        let mut pending = vec![b'x'; 10_000];
        pending.extend_from_slice(b"tail");
        let mut offset = 10_000usize;
        compact_pending_input(&mut pending, &mut offset);
        assert_eq!(pending, b"tail");
        assert_eq!(offset, 0);
    }

    #[test]
    fn output_preserves_unicode_split_between_packets() {
        let mut output = Utf8Output::default();
        output.bytes.extend_from_slice(&[b'a', 0xe4, 0xb8]);
        assert_eq!(output.take(false), "a");
        output.bytes.extend_from_slice(&[0xad, b'b']);
        assert_eq!(output.take(false), "中b");
        assert!(output.bytes.is_empty());
    }

    #[test]
    fn output_replaces_invalid_and_final_incomplete_sequences() {
        let mut output = Utf8Output {
            bytes: vec![0xff, b'a', 0xe4],
        };
        assert_eq!(output.take(false), "�a");
        assert_eq!(output.take(true), "�");
    }
}

mod session_tests {
    use russh::ChannelMsg;

    use crate::domain::ssh::consts::*;
    use crate::domain::ssh::service::session::*;

    #[test]
    fn unknown_or_home_cwd_does_not_add_a_quoted_tilde() {
        assert_eq!(command_in_directory("", "ls"), "ls");
        assert_eq!(command_in_directory("~", "ls"), "ls");
        assert_eq!(
            command_in_directory("/srv/my app", "ls"),
            "cd '/srv/my app' && ls"
        );
        assert_eq!(command_in_directory("", "cd ~ && pwd"), "cd ~ && pwd");
    }

    #[test]
    fn exec_drains_both_streams_and_waits_for_status_after_eof() {
        let mut output = CommandOutput::default();
        output
            .apply(ChannelMsg::Data {
                data: b"out".to_vec().into(),
            })
            .unwrap();
        output
            .apply(ChannelMsg::ExtendedData {
                data: b"err".to_vec().into(),
                ext: 1,
            })
            .unwrap();
        assert!(!output.apply(ChannelMsg::Eof).unwrap());
        output
            .apply(ChannelMsg::ExitStatus { exit_status: 17 })
            .unwrap();
        assert!(output.apply(ChannelMsg::Close).unwrap());
        assert_eq!(output.finish().unwrap(), ("out".into(), "err".into(), 17));
    }

    #[test]
    fn exec_disconnect_without_status_is_not_success() {
        assert!(CommandOutput::default().finish().is_err());
        assert!(CommandOutput::default().apply(ChannelMsg::Failure).is_err());
    }

    #[test]
    fn exec_output_limit_is_reported_not_silently_truncated() {
        let output = CommandOutput::default();
        assert!(output.check_size(MAX_COMMAND_OUTPUT_BYTES).is_ok());
        assert!(output.check_size(MAX_COMMAND_OUTPUT_BYTES + 1).is_err());
    }

    #[test]
    fn parse_cd_target_rejects_a_cd_that_chains_another_command() {
        assert_eq!(
            parse_cd_target("cd /opt/spring-blog && echo hi > compose.yml && sed -i s/a/b/ x"),
            None
        );
        assert_eq!(parse_cd_target("cd /srv && docker compose down"), None);
        assert_eq!(parse_cd_target("cd /tmp; ls -la"), None);
        assert_eq!(parse_cd_target("cd /tmp || true"), None);
        assert_eq!(parse_cd_target("cd /tmp | tee out"), None);
        assert_eq!(parse_cd_target("cd /tmp &"), None);
        assert_eq!(parse_cd_target("cd /tmp > out"), None);
        assert_eq!(parse_cd_target("cd /tmp < in"), None);
        assert_eq!(parse_cd_target("cd /tmp\nrm -rf /"), None);
    }

    #[test]
    fn parse_cd_target_accepts_a_directory_change_on_its_own() {
        assert_eq!(parse_cd_target("cd"), Some(None));
        assert_eq!(parse_cd_target("  cd  "), Some(None));
        assert_eq!(parse_cd_target("cd "), Some(None));
        assert_eq!(
            parse_cd_target("cd /opt/spring-blog"),
            Some(Some("/opt/spring-blog".to_string()))
        );
        assert_eq!(parse_cd_target("cd .."), Some(Some("..".to_string())));
        assert_eq!(parse_cd_target("cd -"), Some(Some("-".to_string())));
        assert_eq!(parse_cd_target("cd ~"), Some(Some("~".to_string())));
        assert_eq!(
            parse_cd_target("cd ~/work"),
            Some(Some("~/work".to_string()))
        );
        assert_eq!(
            parse_cd_target("cd $HOME/logs"),
            Some(Some("$HOME/logs".to_string()))
        );
    }

    #[test]
    fn parse_cd_target_ignores_commands_that_merely_start_with_cd() {
        assert_eq!(parse_cd_target("cdk deploy"), None);
        assert_eq!(parse_cd_target("cd/tmp"), None);
        assert_eq!(parse_cd_target("echo cd /tmp"), None);
        assert_eq!(parse_cd_target("ls"), None);
        assert_eq!(parse_cd_target(""), None);
    }

    #[test]
    fn parse_pwd_output_accepts_only_one_absolute_path() {
        assert_eq!(
            parse_pwd_output("/opt/spring-blog\n"),
            Some("/opt/spring-blog".to_string())
        );
        assert_eq!(
            parse_pwd_output("  /srv/app  "),
            Some("/srv/app".to_string())
        );
        assert_eq!(parse_pwd_output("/"), Some("/".to_string()));
        assert_eq!(parse_pwd_output(""), None);
        assert_eq!(parse_pwd_output("   "), None);
        assert_eq!(parse_pwd_output("relative/path"), None);
        assert_eq!(
            parse_pwd_output("services:\n  web:\n    image: nginx\n/opt/spring-blog"),
            None
        );
        assert_eq!(
            parse_pwd_output(&format!("/{}", "a".repeat(MAX_REMOTE_CWD_LEN))),
            None
        );
    }

    #[test]
    fn parse_pwd_output_rejects_what_sanitize_cwd_would_have_reshaped() {
        let compose_dump = "services:\n  web:\n    image: nginx:alpine\n";
        assert_eq!(
            sanitize_cwd(compose_dump),
            "/services:\n  web:\n    image: nginx:alpine"
        );
        assert_eq!(parse_pwd_output(compose_dump), None);
    }
}

mod transport_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::time::timeout;
    use tokio_util::sync::CancellationToken;

    use crate::domain::ssh::consts::*;
    use crate::domain::ssh::model::{SshAuthType, SshConfig};
    use crate::domain::ssh::service::transport::*;
    use crate::state::AppState;

    fn test_config() -> SshConfig {
        SshConfig {
            id: "config-1".to_string(),
            name: "Test host".to_string(),
            host: "example.invalid".to_string(),
            port: 22,
            username: "tester".to_string(),
            auth_type: SshAuthType::Password,
            password: String::new(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            use_password_fallback: false,
            jump_host_id: None,
            description: String::new(),
            created_at: crate::common::time::now_rfc3339(),
            updated_at: crate::common::time::now_rfc3339(),
        }
    }

    /// The endpoint string is what every handshake/auth error names for the user.
    #[test]
    fn endpoint_includes_user_host_and_port() {
        assert_eq!(endpoint_of(&test_config()), "tester@example.invalid:22");
    }

    /// A silently dropped connection must be detected, while no idle GC may disconnect a quiet
    /// terminal.
    #[test]
    fn client_config_keeps_keepalive_but_disables_idle_gc() {
        let config = client_config();
        assert_eq!(config.keepalive_interval, Some(SSH_KEEPALIVE_INTERVAL));
        assert_eq!(config.keepalive_interval.unwrap().as_secs(), 20);
        assert_eq!(config.keepalive_max, SSH_KEEPALIVE_MAX);
        assert!(config.inactivity_timeout.is_none());
        assert!(config.nodelay);
    }

    #[test]
    fn jump_chain_rejects_cycles_and_over_depth() {
        assert!(validate_jump_chain(0, &[], "a").is_ok());
        assert!(validate_jump_chain(1, &["a".to_string()], "a").is_err());
        assert!(validate_jump_chain(MAX_JUMP_DEPTH, &[], "a").is_err());
        assert!(
            validate_jump_chain(MAX_JUMP_DEPTH - 1, &["a".to_string(), "b".to_string()], "c")
                .is_ok()
        );
    }

    #[tokio::test]
    async fn cancelled_stream_wakes_an_already_pending_read() {
        use tokio::io::AsyncReadExt;
        let (stream, _peer) = tokio::io::duplex(64);
        let cancel = CancellationToken::new();
        let mut stream = CancellableStream::new(stream, cancel.clone());
        let reader = tokio::spawn(async move { stream.read_u8().await });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(timeout(Duration::from_secs(1), reader)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }

    #[test]
    fn connect_returns_immediately_when_already_cancelled() {
        let state = test_state("connect-cancelled");
        let cancel = CancellationToken::new();
        cancel.cancel();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build runtime");
        let error = runtime
            .block_on(connect(&state, None, &test_config(), cancel))
            .err()
            .map(|error| error.to_string())
            .expect("cancelled connect must fail");

        assert_eq!(
            error,
            format!("runtime error: {SSH_CONNECTION_CANCELLED_MESSAGE}")
        );
    }

    fn test_state(name: &str) -> Arc<AppState> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("eshell-transport-{name}-{nonce}"));
        Arc::new(AppState::new(root).expect("create app state"))
    }
}
