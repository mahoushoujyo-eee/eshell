//! The accept loop and per-connection tunnel for one local forward.
//!
//! One [`ForwardRuntime`] owns a bound `TcpListener` and the supervisor task
//! that accepts on it. Each accepted socket gets its own `direct-tcpip` channel
//! on the tab's shared SSH connection, so a slow or stalled tunnel never blocks
//! the accept loop or its siblings.
//!
//! Cancellation is token based, matching the rest of the codebase: stopping a
//! forward cancels the token, which ends the accept loop and every live tunnel.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::common::error::{AppError, AppResult};
use crate::domain::ssh::service::transport::CancellableStream;
use crate::state::{AppState, SharedSshSession};

use super::{on_forward_ended, on_tunnel_count_changed, on_tunnel_finished};
use crate::domain::forward::model::TunnelStats;

/// Cap on simultaneous tunnels through one forward. A local forward is a
/// convenience for a handful of clients, not a load balancer; the cap keeps a
/// runaway client from exhausting the connection's channel budget.
const MAX_TUNNELS_PER_FORWARD: u32 = 256;

/// A live forward: the bound listener plus its supervisor task.
///
/// Dropping the runtime cancels the token and aborts the supervisor, so a
/// forgotten runtime cannot leave a listener behind.
pub(crate) struct ForwardRuntime {
    cancel: CancellationToken,
    supervisor: tokio::task::JoinHandle<()>,
}

impl ForwardRuntime {
    /// Stops the listener and every live tunnel. Idempotent.
    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
        self.supervisor.abort();
    }
}

impl Drop for ForwardRuntime {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.supervisor.abort();
    }
}

/// Binds the local listener and spawns the accept loop.
///
/// Returns the runtime plus the port actually bound, which differs from
/// `bind_port` when the caller asked for `0`.
pub(crate) async fn start(
    state: Arc<AppState>,
    forward_id: String,
    connection: SharedSshSession,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> AppResult<(ForwardRuntime, u16)> {
    let listener = TcpListener::bind((bind_host.as_str(), bind_port))
        .await
        .map_err(|error| {
            AppError::Runtime(format!(
                "failed to bind {bind_host}:{bind_port}: {error}"
            ))
        })?;
    let bound_port = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(bind_port);

    let cancel = CancellationToken::new();
    let open_tunnels = Arc::new(AtomicU64::new(0));
    let supervisor = tokio::spawn(accept_loop(
        Arc::clone(&state),
        forward_id,
        connection,
        listener,
        target_host,
        target_port,
        cancel.clone(),
        Arc::clone(&open_tunnels),
    ));

    Ok((ForwardRuntime { cancel, supervisor }, bound_port))
}

#[allow(clippy::too_many_arguments)]
async fn accept_loop(
    state: Arc<AppState>,
    forward_id: String,
    connection: SharedSshSession,
    listener: TcpListener,
    target_host: String,
    target_port: u16,
    cancel: CancellationToken,
    open_tunnels: Arc<AtomicU64>,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            result = listener.accept() => result,
        };

        let (socket, peer) = match accepted {
            Ok(pair) => pair,
            Err(error) => {
                // A failed accept is per-connection (fd exhaustion, a reset
                // before accept): the listener is still good, so keep serving.
                // Only a closed listener ends the loop.
                if is_fatal_accept_error(&error) {
                    on_forward_ended(&state, &forward_id, format!("listener stopped: {error}"));
                    return;
                }
                continue;
            }
        };

        // The transport can die while the listener stays open (network drop,
        // server-side timeout). Detect it here so the row flips to Failed
        // instead of accepting connections that can never be tunnelled.
        if connection.is_closed() {
            on_forward_ended(&state, &forward_id, "SSH connection closed".to_string());
            return;
        }

        if open_tunnels.load(Ordering::Relaxed) >= u64::from(MAX_TUNNELS_PER_FORWARD) {
            // Drop the socket: the client sees a closed connection, which is
            // the honest answer at the cap.
            continue;
        }

        let tunnel_cancel = cancel.clone();
        let tunnel_state = Arc::clone(&state);
        let tunnel_forward_id = forward_id.clone();
        let tunnel_connection = Arc::clone(&connection);
        let tunnel_target_host = target_host.clone();
        let tunnel_tunnels = Arc::clone(&open_tunnels);

        tokio::spawn(async move {
            tunnel_tunnels.fetch_add(1, Ordering::Relaxed);
            on_tunnel_count_changed(&tunnel_state, &tunnel_forward_id, 1);
            let stats = run_tunnel(
                &tunnel_connection,
                socket,
                &tunnel_target_host,
                target_port,
                peer,
                &tunnel_cancel,
            )
            .await;
            tunnel_tunnels.fetch_sub(1, Ordering::Relaxed);
            // A cancellation is a deliberate stop: the registry is being torn
            // down and must not be touched on the way out.
            if !tunnel_cancel.is_cancelled() {
                on_tunnel_count_changed(&tunnel_state, &tunnel_forward_id, -1);
                on_tunnel_finished(&tunnel_state, &tunnel_forward_id, stats);
            }
        });
    }
}

/// Pumps one client socket through a `direct-tcpip` channel until either side
/// closes. Returns the byte counters, which are zero when the channel could not
/// be opened at all.
async fn run_tunnel(
    connection: &SharedSshSession,
    socket: TcpStream,
    target_host: &str,
    target_port: u16,
    peer: std::net::SocketAddr,
    cancel: &CancellationToken,
) -> TunnelStats {
    let originator = peer.ip().to_string();
    let channel = tokio::select! {
        biased;
        _ = cancel.cancelled() => return TunnelStats::default(),
        result = connection.channel_open_direct_tcpip(
            target_host,
            target_port,
            &originator,
            peer.port(),
        ) => result,
    };

    let channel = match channel {
        Ok(channel) => channel,
        // The client is already gone by the time the channel failed; there is
        // nobody to report to and the forward itself is still healthy.
        Err(_) => return TunnelStats::default(),
    };

    // Tying the channel stream to the connection token means stopping the
    // forward (or the tab dying) interrupts an idle tunnel immediately instead
    // of waiting for the peer to time out.
    let mut remote = CancellableStream::new(channel.into_stream(), connection.cancellation_token());
    let mut local = socket;

    tokio::select! {
        biased;
        _ = cancel.cancelled() => TunnelStats::default(),
        result = copy_bidirectional(&mut local, &mut remote) => match result {
            Ok((up, down)) => TunnelStats {
                bytes_up: up,
                bytes_down: down,
            },
            Err(_) => TunnelStats::default(),
        },
    }
}

/// Whether an accept error means the listener itself is gone.
fn is_fatal_accept_error(error: &std::io::Error) -> bool {
    !matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock
    )
}

