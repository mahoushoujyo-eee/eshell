//! Transport-level errors and stale-connection classification.
//!
//! The ssh2 stack exposed numeric `LIBSSH2_ERROR_*` codes that the service layer used to decide
//! whether a cached connection had died. russh surfaces typed errors instead, so the equivalent
//! classification lives here and is exported for the service layer to reuse.

use thiserror::Error;

use crate::error::AppError;
use crate::models::SshHostKeyTrustChallenge;

use super::SSH_HOST_KEY_TRUST_REQUIRED_PREFIX;

/// Error produced inside the russh client handler.
///
/// `Handler::Error` must be `From<russh::Error> + Send + Debug`, so this type is what crosses the
/// boundary between the handler callback and [`super::connect`].
#[derive(Debug, Error)]
pub enum TransportError {
    /// The server presented a key that is unknown, or that does not match the stored fingerprint.
    ///
    /// Returned from `check_server_key`, which russh propagates out of the connect call.
    #[error("SSH host key trust required for {}:{}", .0.host, .0.port)]
    HostKeyTrustRequired(SshHostKeyTrustChallenge),
    #[error(transparent)]
    Russh(#[from] russh::Error),
}

/// Builds the `SSH_HOST_KEY_TRUST_REQUIRED:<json>` runtime error the frontend matches on.
pub fn host_key_trust_required(challenge: SshHostKeyTrustChallenge) -> AppError {
    let payload = serde_json::to_string(&challenge).unwrap_or_else(|_| "{}".to_string());
    AppError::Runtime(format!("{SSH_HOST_KEY_TRUST_REQUIRED_PREFIX}{payload}"))
}

/// Maps a russh connect/handshake failure to an [`AppError`], keeping the semantic classes the UI
/// already distinguishes: algorithm mismatch, interrupted key exchange, handshake timeout,
/// closed transport, and plain IO.
pub fn map_russh_connect_error(error: russh::Error, endpoint: &str) -> AppError {
    match error {
        russh::Error::NoCommonAlgo { .. } => AppError::Runtime(format!(
            "SSH algorithm negotiation failed for {endpoint}. Client and server share no compatible \
             key exchange, cipher, host key or MAC algorithm. Check the server-side sshd algorithm \
             settings or use a host with modern SSH settings."
        )),
        russh::Error::Kex | russh::Error::KexInit => AppError::Runtime(format!(
            "SSH key exchange was interrupted for {endpoint}. The server or network closed the \
             connection during the handshake, for example sshd shedding load under MaxStartups. \
             Retrying usually succeeds."
        )),
        russh::Error::ConnectionTimeout => AppError::Runtime(format!(
            "SSH handshake timed out for {endpoint}. The server accepted the TCP connection but did \
             not complete the SSH handshake in time."
        )),
        russh::Error::HUP | russh::Error::Disconnect => AppError::Runtime(format!(
            "SSH connection to {endpoint} was closed during the handshake."
        )),
        russh::Error::IO(error) => AppError::Io(error),
        other => AppError::SshTransport(other),
    }
}

/// Whether an error means the underlying SSH transport is gone, as opposed to a remote command
/// exiting non-zero, a missing path, a permission problem, or a channel the server refused to
/// open for administrative/resource reasons.
///
/// This is the russh replacement for the old `LIBSSH2_ERROR_*` code matching. Callers use it to
/// decide whether to evict a cached connection; a false positive throws away a healthy connection,
/// so the classification is deliberately conservative.
pub fn is_stale_connection_error(error: &AppError) -> bool {
    match error {
        AppError::SshTransport(error) => is_stale_russh_error(error),
        AppError::Sftp(error) => is_stale_sftp_error(error),
        AppError::Io(error) => is_stale_io_kind(error.kind()),
        _ => false,
    }
}

fn is_stale_russh_error(error: &russh::Error) -> bool {
    match error {
        russh::Error::IO(error) => is_stale_io_kind(error.kind()),
        russh::Error::HUP
        | russh::Error::Disconnect
        | russh::Error::SendError
        | russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout
        | russh::Error::InactivityTimeout
        | russh::Error::DecryptionError => true,
        // Deliberately NOT stale:
        // - ChannelOpenFailure: an admin/resource limit rejects one new channel while the
        //   transport itself is healthy. Evicting here would tear down a working PTY.
        // - RequestDenied / NotAuthenticated / UnsupportedAuthMethod / NoAuthMethod: remote policy.
        // - UnknownKey / Keys: key material, not the transport.
        // - Kex / NoCommonAlgo: deterministic negotiation failure, reconnecting cannot help.
        _ => false,
    }
}

fn is_stale_sftp_error(error: &russh_sftp::client::error::Error) -> bool {
    // `Status` can also be a plain "no such file"; only the transport-shaped variants qualify.
    matches!(
        error,
        russh_sftp::client::error::Error::IO(_) | russh_sftp::client::error::Error::Timeout
    )
}

fn is_stale_io_kind(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::UnexpectedEof
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SshHostKeyTrustChallenge, SshHostKeyTrustReason};

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
