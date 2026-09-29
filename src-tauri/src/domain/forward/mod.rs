//! Port forwarding domain: `-L` style local forwards over a shell tab's SSH
//! connection.
//!
//! A forward binds a local TCP listener and tunnels every accepted connection
//! through the tab's existing SSH transport as a `direct-tcpip` channel. The
//! target host is resolved by the *server*, so `localhost:3306` means the
//! server's own loopback, not the client's.
//!
//! `model.rs` holds the wire structs; `service/` owns the plugin state and the
//! accept loop — including the Tauri command adapters registered in `lib.rs`.

pub mod model;
pub(crate) mod service;

#[cfg(test)]
mod tests;
