//! russh client handler: host-key trust-on-first-use enforcement and disconnect signalling.
//!
//! The only server callbacks the transport relies on are `check_server_key` (TOFU) and
//! `disconnected` (liveness). Authentication banners and channel callbacks keep the default
//! behaviour: command/PTY/SFTP channels are opened by the caller through [`russh::Channel`], not
//! through handler callbacks.

use std::sync::{Arc, Weak};

use russh::client::{self, DisconnectReason};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use tokio_util::sync::CancellationToken;

use crate::domain::ssh::model::{SshHostKeyTrustChallenge, SshHostKeyTrustReason};
use crate::state::AppState;

use crate::domain::ssh::error::TransportError;

/// One handler instance per connection attempt, holding a weak reference to the shared app state
/// used to resolve `known_hosts`, plus the connection token cancelled when the session ends.
///
/// The weak reference matters: the handler lives inside the spawned russh session task, which is
/// reachable from `AppState`'s connection cache. A strong `Arc<AppState>` here would form a cycle
/// and keep the whole state (and its storage) alive until every session was explicitly shut down.
pub struct ConnectionHandler {
    state: Weak<AppState>,
    host: String,
    port: u16,
    cancel: CancellationToken,
}

impl ConnectionHandler {
    pub fn new(state: &Arc<AppState>, host: String, port: u16, cancel: CancellationToken) -> Self {
        Self {
            state: Arc::downgrade(state),
            host,
            port,
            cancel,
        }
    }
}

impl client::Handler for ConnectionHandler {
    type Error = TransportError;

    /// Trust-on-first-use: accept the key only when it matches a stored fingerprint. Anything else
    /// aborts the handshake with a structured challenge the UI turns into a trust prompt.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Upgrade only for the duration of the lookup; the app state is alive while a connect is in
        // flight, and holding the `Arc` no longer than this call keeps it collectible afterwards.
        let Some(state) = self.state.upgrade() else {
            return Err(TransportError::Russh(russh::Error::Disconnect));
        };

        let public_key = server_public_key.public_key();
        let fingerprint = public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = public_key.algorithm().as_str().to_string();

        match state.storage.find_known_host(&self.host, self.port) {
            Some(known_host) if known_host.fingerprint == fingerprint => Ok(true),
            Some(known_host) => Err(TransportError::HostKeyTrustRequired(
                SshHostKeyTrustChallenge {
                    reason: SshHostKeyTrustReason::Changed,
                    host: self.host.clone(),
                    port: self.port,
                    key_type,
                    fingerprint,
                    trusted_fingerprint: Some(known_host.fingerprint),
                },
            )),
            None => Err(TransportError::HostKeyTrustRequired(
                SshHostKeyTrustChallenge {
                    reason: SshHostKeyTrustReason::Unknown,
                    host: self.host.clone(),
                    port: self.port,
                    key_type,
                    fingerprint,
                    trusted_fingerprint: None,
                },
            )),
        }
    }

    /// The session has actually ended (remote close, keepalive exhaustion, error). Cancelling the
    /// connection token wakes every waiter selecting on it, and tells cache holders that
    /// [`super::Connection::is_closed`] is now meaningful.
    ///
    /// This is required because dropping a russh `Handle` only logs: while any open channel still
    /// holds a message sender, the transport would otherwise stay alive unnoticed.
    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        self.cancel.cancel();
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(error) => Err(error),
        }
    }
}
