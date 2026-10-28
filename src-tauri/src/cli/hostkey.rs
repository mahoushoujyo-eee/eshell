//! Host-key policy for headless connections.
//!
//! The desktop app verifies a server's host key against `known_hosts.json`
//! and, when the key is unknown or changed, asks the user to approve it in a
//! dialog. A CLI or an MCP server has nobody to ask, so the policy is decided
//! up front:
//!
//! - [`HostKeyPolicy::AcceptAny`] trusts an unknown key and overwrites a
//!   changed one. A changed key is reported on stderr, because silently
//!   accepting it would hide the one signal that matters.
//! - [`HostKeyPolicy::Strict`] refuses both and lets the operator add the
//!   fingerprint to `known_hosts.json` by hand.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::domain::ssh::consts::SSH_HOST_KEY_TRUST_REQUIRED_PREFIX;
use crate::domain::ssh::model::{
    SshConfig, SshHostKeyTrustChallenge, SshHostKeyTrustReason, TrustSshHostKeyInput,
};
use crate::domain::ssh::service::transport::{self, Connection};
use crate::state::AppState;

/// How an unknown or changed host key is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKeyPolicy {
    /// Trust an unknown key; overwrite a changed one.
    AcceptAny,
    /// Refuse an unknown or changed key.
    Strict,
}

impl HostKeyPolicy {
    /// The policy from the `--strict-host-key` flag.
    pub(crate) fn from_strict_flag(strict: bool) -> Self {
        if strict {
            HostKeyPolicy::Strict
        } else {
            HostKeyPolicy::AcceptAny
        }
    }
}

/// Opens one SSH connection, applying the host-key policy.
///
/// A connection refused by the host-key check is retried once after the key
/// has been recorded — the check runs during the handshake, so the retry is
/// a fresh connect, not a continuation of the failed one.
pub(crate) async fn connect(
    state: &Arc<AppState>,
    config: &SshConfig,
    cancel: CancellationToken,
    policy: HostKeyPolicy,
) -> AppResult<Connection> {
    match transport::connect(state, None, config, cancel.clone()).await {
        Ok(connection) => Ok(connection),
        Err(error) => {
            let Some(challenge) = parse_trust_challenge(&error) else {
                return Err(error);
            };
            if policy == HostKeyPolicy::Strict {
                return Err(error);
            }
            report_and_trust(&challenge);
            state.storage.trust_ssh_host_key(TrustSshHostKeyInput {
                host: challenge.host.clone(),
                port: challenge.port,
                key_type: challenge.key_type.clone(),
                fingerprint: challenge.fingerprint.clone(),
            })?;
            transport::connect(state, None, config, cancel).await
        }
    }
}

/// Announces the trust decision on stderr.
///
/// A changed key is called out separately: the operator asked for the new
/// fingerprint to replace the old one, but that is exactly the case where a
/// man-in-the-middle would be hiding, so it never passes silently.
fn report_and_trust(challenge: &SshHostKeyTrustChallenge) {
    match challenge.reason {
        SshHostKeyTrustReason::Unknown => {
            eprintln!(
                "eshell: trusting unknown host key for {}:{} ({})",
                challenge.host, challenge.port, challenge.fingerprint
            );
        }
        SshHostKeyTrustReason::Changed => {
            eprintln!(
                "eshell: WARNING: host key for {}:{} changed ({} -> {}); the trusted \
                 fingerprint was overwritten. Use --strict-host-key to refuse this instead.",
                challenge.host,
                challenge.port,
                challenge.trusted_fingerprint.as_deref().unwrap_or("unknown"),
                challenge.fingerprint
            );
        }
    }
}

/// Extracts the trust challenge from a transport error.
fn parse_trust_challenge(error: &AppError) -> Option<SshHostKeyTrustChallenge> {
    let rendered = error.to_string();
    let (_, payload) = rendered.split_once(SSH_HOST_KEY_TRUST_REQUIRED_PREFIX)?;
    serde_json::from_str(payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ssh::error::host_key_trust_required;

    fn challenge(reason: SshHostKeyTrustReason) -> SshHostKeyTrustChallenge {
        SshHostKeyTrustChallenge {
            reason,
            host: "example.invalid".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:new".to_string(),
            trusted_fingerprint: Some("SHA256:old".to_string()),
        }
    }

    #[test]
    fn a_trust_challenge_is_recognised_in_the_error_text() {
        let error = host_key_trust_required(challenge(SshHostKeyTrustReason::Unknown));
        let parsed = parse_trust_challenge(&error).expect("challenge must be parsed");
        assert_eq!(parsed.host, "example.invalid");
        assert_eq!(parsed.port, 22);
        assert_eq!(parsed.fingerprint, "SHA256:new");
    }

    #[test]
    fn an_unrelated_error_is_not_mistaken_for_a_challenge() {
        let error = AppError::Runtime("connection refused".to_string());
        assert!(parse_trust_challenge(&error).is_none());
    }

    #[test]
    fn the_flag_selects_the_policy() {
        assert_eq!(
            HostKeyPolicy::from_strict_flag(true),
            HostKeyPolicy::Strict
        );
        assert_eq!(
            HostKeyPolicy::from_strict_flag(false),
            HostKeyPolicy::AcceptAny
        );
    }
}
