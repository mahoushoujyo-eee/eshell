//! Unit tests for `ssh/error.rs`: the trust-required payload and the stale-connection
//! classification the connection cache evicts on.

use crate::common::error::AppError;
use crate::domain::ssh::consts::SSH_HOST_KEY_TRUST_REQUIRED_PREFIX;
use crate::domain::ssh::error::{host_key_trust_required, is_stale_connection_error};
use crate::domain::ssh::model::{SshHostKeyTrustChallenge, SshHostKeyTrustReason};

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
