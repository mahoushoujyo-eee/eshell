//! Local MCP (Model Context Protocol) bridge.
//!
//! Exposes eShell's SSH profiles, active shell sessions, remote command
//! execution, SFTP file access, and server status as MCP tools over a
//! loopback streamable-HTTP endpoint. ACP agent sessions get this endpoint
//! injected automatically (see `acp_agent_start`), so external coding agents
//! can operate the servers the user already manages in eShell; destructive
//! tool calls still flow through the agent's own permission prompts, which
//! the ACP panel surfaces as approval cards.
//!
//! Transport: MCP streamable HTTP with a single JSON response per POST (no
//! SSE stream, which the spec permits). Bound to 127.0.0.1 with a per-run
//! bearer token so other local processes cannot call it.
//!
//! The protocol logic is not here: this module is the HTTP transport over
//! [`super::mcp_server::McpServer`], the same core the standalone
//! `eshell-mcp` binary serves over stdio.

use std::sync::Arc;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::AUTHORIZATION;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;

use crate::domain::agent::consts::*;
use crate::domain::agent::service::mcp_server::McpServer;
use crate::state::{AppState, McpBridgeInfo};

/// Binds the loopback listener, registers the endpoint in app state, and
/// serves connections for the lifetime of the app.
pub async fn start(state: Arc<AppState>) -> Result<McpBridgeInfo, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bind mcp bridge: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("mcp bridge local addr: {e}"))?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let info = McpBridgeInfo {
        port,
        token: token.clone(),
    };
    state.set_mcp_bridge(info.clone());

    let server = McpServer::in_app(Arc::clone(&state));
    tokio::spawn(serve(listener, server, token));
    Ok(info)
}

/// Serves the MCP endpoint over HTTP until the listener dies.
///
/// Shared with the standalone server, which binds its own listener and calls
/// this with a server whose session resolver can open connections on demand.
pub(crate) async fn serve(
    listener: tokio::net::TcpListener,
    server: McpServer,
    token: String,
) {
    let server = McpServerHandle::new(server);
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => continue,
        };
        let io = TokioIo::new(stream);
        let server = server.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request: Request<Incoming>| {
                let server = server.clone();
                let token = token.clone();
                async move {
                    Ok::<_, std::convert::Infallible>(handle_http(request, &server, &token).await)
                }
            });
            let _ = http1::Builder::new().serve_connection(io, service).await;
        });
    }
}

/// A cheaply cloneable handle to the server, so each connection task owns one.
#[derive(Clone)]
struct McpServerHandle(Arc<McpServer>);

impl McpServerHandle {
    fn new(server: McpServer) -> Self {
        Self(Arc::new(server))
    }
}

impl std::ops::Deref for McpServerHandle {
    type Target = McpServer;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

async fn handle_http(
    request: Request<Incoming>,
    server: &McpServer,
    token: &str,
) -> Response<Full<Bytes>> {
    if request.uri().path() != MCP_PATH {
        return plain_response(StatusCode::NOT_FOUND, "not found");
    }
    if request.method() != Method::POST {
        return plain_response(StatusCode::METHOD_NOT_ALLOWED, "POST only");
    }

    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == format!("Bearer {token}"))
        .unwrap_or(false);
    if !authorized {
        return plain_response(StatusCode::UNAUTHORIZED, "missing or invalid bearer token");
    }

    let body = match Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(_) => return plain_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large"),
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return plain_response(StatusCode::BAD_REQUEST, "invalid JSON");
    };

    // Notifications (no id) get acknowledged without a body, per streamable HTTP.
    if message.get("id").is_none() {
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Full::new(Bytes::new()))
            .unwrap();
    }

    // Tool calls await SSH/SFTP work directly on the connection task.
    let response = server.handle(&message).await;

    let payload = serde_json::to_vec(&response).unwrap_or_default();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(payload)))
        .unwrap()
}

fn plain_response(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(Full::new(Bytes::from(message.to_string())))
        .unwrap()
}

/// Dispatches one JSON-RPC request against the desktop app's server.
///
/// The unit tests drive the protocol through this entry point; the HTTP
/// transport holds a long-lived [`McpServer`] instead.
#[cfg(test)]
pub(crate) async fn handle_rpc(state: &Arc<AppState>, message: &Value) -> Value {
    McpServer::in_app(Arc::clone(state)).handle(message).await
}
