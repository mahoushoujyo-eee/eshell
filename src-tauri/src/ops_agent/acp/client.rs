//! Client-side session runner on the official ACP SDK.
//!
//! One [`AcpSessionRunner`] wraps a single ACP connection to one agent
//! subprocess. The SDK's `connect_with` owns the connection lifetime: our
//! `main_fn` parks on a request channel for the lifetime of the session, so
//! prompts/cancels submitted from Tauri commands are executed inside the
//! connection context while streaming updates flow to the [`EventSink`].
//!
//! Client capabilities advertised to agents: `fs/read_text_file` and
//! `fs/write_text_file` (served here), no terminal. Permission requests are
//! forwarded to the frontend as `permission_request` events; the [`Responder`]
//! is parked in [`AcpSessionRunner::pending_permissions`] until the user picks
//! an option (`acp_permission_respond`) or the turn is cancelled, which
//! resolves every pending request as `Cancelled` per the ACP spec.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, Weak};

use agent_client_protocol::schema::v1::{
    AuthMethod, AuthenticateRequest, AvailableCommand, AvailableCommandInput, CancelNotification,
    ClientCapabilities, ContentBlock, FileSystemCapabilities, ImageContent, Implementation,
    InitializeRequest, LoadSessionRequest, McpServer, NewSessionRequest, NewSessionResponse,
    PermissionOption, Plan, PromptRequest, ReadTextFileRequest, ReadTextFileResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigId, SessionConfigOption, SessionConfigOptionValue,
    SessionId, SessionModeId, SessionModeState, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest,
    TextContent, ToolCall, ToolCallLocation, ToolCallUpdate, UsageUpdate, WriteTextFileRequest,
    WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, ErrorCode, Responder};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Mutex};

/// Streaming stage values bridged onto the `acp-agent-stream` Tauri event.
/// Turn completion is carried by the `acp_session_prompt` response, not a
/// separate event; errors surface through the command's `Err` payload, and
/// connection loss through the `stopped` stage.
pub const STAGE_DELTA: &str = "delta";
pub const STAGE_USER: &str = "user";
pub const STAGE_THOUGHT: &str = "thought";
pub const STAGE_TOOL_CALL: &str = "tool_call";
pub const STAGE_TOOL_UPDATE: &str = "tool_call_update";
pub const STAGE_PLAN: &str = "plan";
pub const STAGE_COMMANDS: &str = "commands";
pub const STAGE_MODE: &str = "mode";
pub const STAGE_CONFIG_OPTIONS: &str = "config_options";
pub const STAGE_USAGE: &str = "usage";
pub const STAGE_PERMISSION_REQUEST: &str = "permission_request";
pub const STAGE_PERMISSION_RESOLVED: &str = "permission_resolved";
pub const STAGE_STOPPED: &str = "stopped";

/// Payload emitted on the `acp-agent-stream` event channel (camelCase for the frontend).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStreamEvent {
    pub agent_id: String,
    pub session_id: String,
    pub stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<AcpToolCallView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<AcpPlanEntryView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<AcpCommandView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_mode_id: Option<String>,
    /// Full replacement set of session config options (model, thought level,
    /// ...). Forwarded as the SDK type so unknown categories, grouped selects
    /// and `_meta` survive untouched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<AcpUsageView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<AcpPermissionRequestView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_resolution: Option<AcpPermissionResolutionView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AcpStreamEvent {
    fn new(agent_id: &str, session_id: impl Into<String>, stage: &'static str) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            session_id: session_id.into(),
            stage,
            chunk: None,
            tool_call: None,
            plan: None,
            commands: None,
            current_mode_id: None,
            config_options: None,
            usage: None,
            permission: None,
            permission_resolution: None,
            error: None,
        }
    }
}

/// Flat tool-call view consumed by the frontend panel. For `tool_call` events
/// every descriptive field is set; for `tool_call_update` only changed fields
/// are present and the frontend merges them by `toolCallId`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCallView {
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<AcpToolContentView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<AcpToolLocationView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<Value>,
}

/// Tool-call content block: streamed output text, a file diff, or an
/// agent-managed terminal reference.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpToolContentView {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        old_text: Option<String>,
        new_text: String,
    },
    #[serde(rename_all = "camelCase")]
    Terminal { terminal_id: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolLocationView {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPlanEntryView {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCommandView {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpUsageView {
    pub used: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOptionView {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequestView {
    pub request_id: String,
    pub tool_call: AcpToolCallView,
    pub options: Vec<AcpPermissionOptionView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionResolutionView {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    pub cancelled: bool,
}

/// Session modes advertised by the agent at session creation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModesView {
    pub current_mode_id: String,
    pub available_modes: Vec<AcpModeView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModeView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentInfoView {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A sign-in method advertised by the agent during `initialize`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethodView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Capabilities the agent advertised during `initialize`, filtered to what
/// the panel acts on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentCapsView {
    /// Agent supports `session/load` (native history resume).
    pub load_session: bool,
    /// Agent accepts image content blocks in prompts.
    pub prompt_image: bool,
}

/// Result of `start` (and of `authenticate`, once sign-in succeeds).
///
/// When the agent rejects session creation with AUTH_REQUIRED, the connection
/// is kept alive and `auth_required` is set together with the advertised
/// methods; `acp_agent_authenticate` completes the session afterwards.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStartInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub auth_methods: Vec<AcpAuthMethodView>,
    /// True when a requested `session/load` resume actually succeeded; a
    /// resume that fell back to a fresh session reports `false`.
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<AcpAgentCapsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<AcpModesView>,
    /// Session config options advertised at session creation (both Codex and
    /// Claude Code ship model + thought-level selectors here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_info: Option<AcpAgentInfoView>,
}

/// Tauri app handle abstraction so the event loop stays decoupled from Tauri.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: AcpStreamEvent);
}

/// Adapter implementing [`EventSink`] on a `tauri::AppHandle`.
pub struct TauriEventSink(pub tauri::AppHandle);

impl EventSink for TauriEventSink {
    fn emit(&self, event: AcpStreamEvent) {
        use tauri::Emitter as _;
        let _ = self.0.emit("acp-agent-stream", &event);
    }
}

/// Result of one finished prompt turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResult {
    pub stop_reason: Option<String>,
}

/// One image attachment for a prompt turn (base64 payload + mime type).
#[derive(Debug, Clone)]
pub struct AcpPromptImage {
    pub data: String,
    pub mime_type: String,
}

/// Requests processed inside the connection's `main_fn`.
enum SessionRequest {
    Prompt {
        session_id: String,
        content: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<AcpPromptResult, String>>,
    },
    Cancel {
        session_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetMode {
        session_id: String,
        mode_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetConfigOption {
        session_id: String,
        config_id: String,
        value: SessionConfigOptionValue,
        /// The agent answers with the full, updated option set.
        reply: oneshot::Sender<Result<Vec<SessionConfigOption>, String>>,
    },
    Authenticate {
        method_id: String,
        reply: oneshot::Sender<Result<AcpStartInfo, String>>,
    },
}

/// A permission request parked while the user decides in the frontend.
struct PendingPermission {
    session_id: String,
    responder: Responder<RequestPermissionResponse>,
}

type PendingPermissions = Arc<StdMutex<HashMap<String, PendingPermission>>>;

/// A live ACP session bound to one agent subprocess.
pub struct AcpSessionRunner {
    agent_id: String,
    /// Submission channel into the parked connection loop; `None` when stopped.
    tx: Mutex<Option<mpsc::UnboundedSender<SessionRequest>>>,
    /// Permission requests awaiting a user decision, keyed by request id.
    pending_permissions: PendingPermissions,
    /// Sink of the current connection; used to emit permission resolutions.
    sink: StdMutex<Option<Arc<dyn EventSink>>>,
}

impl AcpSessionRunner {
    /// Creates an unstarted runner for the given agent id.
    pub fn new(agent_id: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            tx: Mutex::new(None),
            pending_permissions: Arc::new(StdMutex::new(HashMap::new())),
            sink: StdMutex::new(None),
        }
    }

    /// Whether the runner holds a live connection.
    pub async fn is_running(&self) -> bool {
        self.tx.lock().await.is_some()
    }

    /// Spawns the agent, completes the handshake (advertising fs capabilities),
    /// creates one session — or resumes `resume_session_id` via `session/load`
    /// when the agent supports it — and parks the connection loop for the
    /// session lifetime. Returns the session id plus handshake info.
    pub async fn start(
        self: &Arc<Self>,
        spawn: AcpAgent,
        cwd: PathBuf,
        mcp_servers: Vec<McpServer>,
        resume_session_id: Option<String>,
        sink: Arc<dyn EventSink>,
    ) -> Result<AcpStartInfo, String> {
        let mut guard = self.tx.lock().await;
        if guard.is_some() {
            return Err("acp session already started".to_string());
        }

        *self.sink.lock().unwrap() = Some(Arc::clone(&sink));

        let (tx, rx) = mpsc::unbounded_channel::<SessionRequest>();
        let (session_tx, session_rx) = oneshot::channel::<Result<AcpStartInfo, String>>();
        let agent_id = self.agent_id.clone();
        let pending = Arc::clone(&self.pending_permissions);
        let runner = Arc::downgrade(self);

        // The SDK owns the connection for as long as this future runs; park it
        // in a background task and surface the session id once ready.
        tokio::spawn(run_connection(
            spawn,
            cwd,
            mcp_servers,
            resume_session_id,
            agent_id,
            sink,
            rx,
            session_tx,
            pending,
            runner,
        ));

        let info = session_rx
            .await
            .map_err(|_| "acp connection ended before session creation".to_string())??;
        *guard = Some(tx);
        Ok(info)
    }

    /// Sends one prompt turn (text plus optional image blocks); resolves when
    /// the agent finishes the turn while deltas stream through the event sink.
    pub async fn prompt(
        &self,
        session_id: &str,
        text: &str,
        images: Vec<AcpPromptImage>,
    ) -> Result<AcpPromptResult, String> {
        let mut content: Vec<ContentBlock> = Vec::with_capacity(1 + images.len());
        if !text.trim().is_empty() {
            content.push(ContentBlock::Text(TextContent::new(text.to_string())));
        }
        for image in images {
            content.push(ContentBlock::Image(ImageContent::new(
                image.data,
                image.mime_type,
            )));
        }
        if content.is_empty() {
            return Err("prompt is empty".to_string());
        }
        let (reply, rx) = oneshot::channel();
        self.submit(SessionRequest::Prompt {
            session_id: session_id.to_string(),
            content,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "acp connection dropped".to_string())?
    }

    /// Cancels the in-flight turn via the `session/cancel` notification and
    /// resolves every pending permission request as cancelled (spec-mandated).
    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.submit(SessionRequest::Cancel {
            session_id: session_id.to_string(),
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "acp connection dropped".to_string())?
    }

    /// Switches the session mode via `session/set_mode`.
    /// Sets one session config option (model, thought level, ...) and returns
    /// the agent's full updated option set.
    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: SessionConfigOptionValue,
    ) -> Result<Vec<SessionConfigOption>, String> {
        let (reply, rx) = oneshot::channel();
        self.submit(SessionRequest::SetConfigOption {
            session_id: session_id.to_string(),
            config_id: config_id.to_string(),
            value,
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "acp connection dropped".to_string())?
    }

    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.submit(SessionRequest::SetMode {
            session_id: session_id.to_string(),
            mode_id: mode_id.to_string(),
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "acp connection dropped".to_string())?
    }

    /// Runs the agent's sign-in flow for one advertised auth method (may take
    /// minutes — e.g. a browser OAuth round-trip) and then creates the session
    /// the initial `start` could not.
    pub async fn authenticate(&self, method_id: &str) -> Result<AcpStartInfo, String> {
        let (reply, rx) = oneshot::channel();
        self.submit(SessionRequest::Authenticate {
            method_id: method_id.to_string(),
            reply,
        })
        .await?;
        rx.await
            .map_err(|_| "acp connection dropped".to_string())?
    }

    /// Resolves one parked permission request with the user's decision.
    /// `option_id: None` rejects the request as cancelled.
    pub fn respond_permission(
        &self,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<(), String> {
        let pending = self
            .pending_permissions
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| format!("unknown or already resolved permission request `{request_id}`"))?;

        let outcome = match option_id {
            Some(option_id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option_id.to_string(),
            )),
            None => RequestPermissionOutcome::Cancelled,
        };
        pending
            .responder
            .respond(RequestPermissionResponse::new(outcome))
            .map_err(|e| e.to_string())?;

        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            let mut event = AcpStreamEvent::new(
                &self.agent_id,
                pending.session_id,
                STAGE_PERMISSION_RESOLVED,
            );
            event.permission_resolution = Some(AcpPermissionResolutionView {
                request_id: request_id.to_string(),
                option_id: option_id.map(str::to_string),
                cancelled: option_id.is_none(),
            });
            sink.emit(event);
        }
        Ok(())
    }

    /// Resolves every pending permission request as cancelled and notifies the
    /// frontend. The ACP spec requires this whenever the client cancels a turn.
    pub fn resolve_pending_permissions_cancelled(&self) {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            resolve_all_permissions_cancelled(&self.pending_permissions, &self.agent_id, sink);
        }
    }

    /// Ends the session: drops the submission channel so the parked loop
    /// unwinds and the SDK closes the subprocess.
    pub async fn stop(&self) {
        *self.tx.lock().await = None;
    }

    async fn submit(&self, request: SessionRequest) -> Result<(), String> {
        let guard = self.tx.lock().await;
        guard
            .as_ref()
            .ok_or("acp session not started")?
            .send(request)
            .map_err(|_| "acp connection dropped".to_string())
    }
}

/// Runs the SDK connection: handshake with fs capabilities, session creation,
/// then parks on the request channel until the runner is stopped. On exit —
/// clean or not — clears the runner, cancels parked permissions, and emits a
/// `stopped` event so the frontend can reset.
#[allow(clippy::too_many_arguments)]
async fn run_connection(
    spawn: AcpAgent,
    cwd: PathBuf,
    mcp_servers: Vec<McpServer>,
    resume_session_id: Option<String>,
    agent_id: String,
    sink: Arc<dyn EventSink>,
    rx: mpsc::UnboundedReceiver<SessionRequest>,
    session_tx: oneshot::Sender<Result<AcpStartInfo, String>>,
    pending: PendingPermissions,
    runner: Weak<AcpSessionRunner>,
) {
    // Shared with main_fn: consumed on successful startup, otherwise used to
    // surface the connection error to the waiting `start` call.
    let session_tx = Arc::new(StdMutex::new(Some(session_tx)));
    let session_id = Arc::new(StdMutex::new(String::new()));

    let connect_result = {
        let agent_id_for_updates = agent_id.clone();
        let sink_for_updates = Arc::clone(&sink);
        let agent_id_for_permissions = agent_id.clone();
        let sink_for_permissions = Arc::clone(&sink);
        let pending_for_permissions = Arc::clone(&pending);
        let session_tx = Arc::clone(&session_tx);
        let session_id = Arc::clone(&session_id);
        let mut rx = rx;

        Client
            .builder()
            .on_receive_notification(
                move |notification: SessionNotification, _cx| {
                    let agent_id = agent_id_for_updates.clone();
                    let sink = Arc::clone(&sink_for_updates);
                    async move {
                        for event in translate_notification(&agent_id, &notification) {
                            sink.emit(event);
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                move |request: RequestPermissionRequest,
                      responder: Responder<RequestPermissionResponse>,
                      _cx| {
                    let agent_id = agent_id_for_permissions.clone();
                    let sink = Arc::clone(&sink_for_permissions);
                    let pending = Arc::clone(&pending_for_permissions);
                    async move {
                        // Park the responder and hand the decision to the user;
                        // `acp_permission_respond` or cancellation resolves it.
                        // Handlers must return promptly — awaiting the user here
                        // would stall the whole dispatch loop.
                        let request_id = uuid::Uuid::new_v4().to_string();
                        let request_session = request.session_id.to_string();
                        let view = AcpPermissionRequestView {
                            request_id: request_id.clone(),
                            tool_call: tool_call_update_view(&request.tool_call),
                            options: request.options.iter().map(permission_option_view).collect(),
                        };
                        pending.lock().unwrap().insert(
                            request_id,
                            PendingPermission {
                                session_id: request_session.clone(),
                                responder,
                            },
                        );
                        let mut event = AcpStreamEvent::new(
                            &agent_id,
                            request_session,
                            STAGE_PERMISSION_REQUEST,
                        );
                        event.permission = Some(view);
                        sink.emit(event);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                |request: ReadTextFileRequest, responder: Responder<ReadTextFileResponse>, _cx| async move {
                    match read_text_file(&request).await {
                        Ok(content) => responder.respond(ReadTextFileResponse::new(content)),
                        Err(message) => responder.respond_with_internal_error(message),
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                |request: WriteTextFileRequest, responder: Responder<WriteTextFileResponse>, _cx| async move {
                    match write_text_file(&request).await {
                        Ok(()) => responder.respond(WriteTextFileResponse::default()),
                        Err(message) => responder.respond_with_internal_error(message),
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(spawn, move |connection: ConnectionTo<Agent>| async move {
                let init = connection
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_capabilities(
                                ClientCapabilities::new().fs(
                                    FileSystemCapabilities::new()
                                        .read_text_file(true)
                                        .write_text_file(true),
                                ),
                            )
                            .client_info(Implementation::new("eshell", env!("CARGO_PKG_VERSION"))),
                    )
                    .block_task()
                    .await?;

                let agent_info = init.agent_info.as_ref().map(|implementation| AcpAgentInfoView {
                    name: implementation.name.clone(),
                    version: implementation.version.clone(),
                    title: implementation.title.clone(),
                });
                let capabilities = AcpAgentCapsView {
                    load_session: init.agent_capabilities.load_session,
                    prompt_image: init.agent_capabilities.prompt_capabilities.image,
                };

                let context = SessionContext {
                    cwd,
                    mcp_servers,
                    resume_session_id,
                    load_session_supported: capabilities.load_session,
                    capabilities,
                    session_id: Arc::clone(&session_id),
                    agent_info,
                };

                // Agents that need sign-in reject the first `session/new` with
                // AUTH_REQUIRED; keep the connection alive and let the user
                // pick one of the advertised auth methods instead of failing.
                let phase_one = match establish_session(&connection, &context).await {
                    Ok(info) => info,
                    Err(error) if is_auth_required_error(&error) => AcpStartInfo {
                        session_id: None,
                        auth_required: true,
                        auth_methods: init.auth_methods.iter().map(auth_method_view).collect(),
                        resumed: false,
                        capabilities: Some(context.capabilities.clone()),
                        modes: None,
                        config_options: None,
                        agent_info: context.agent_info.clone(),
                    },
                    Err(error) => return Err(error),
                };
                if let Some(session_tx) = session_tx.lock().unwrap().take() {
                    let _ = session_tx.send(Ok(phase_one));
                }

                park_loop(connection, &mut rx, context).await;
                Ok(())
            })
            .await
    };

    let error = connect_result.err().map(|e| e.to_string());

    // Unblock a `start` still waiting on the handshake BEFORE touching
    // `runner.tx` — `start` holds that lock while it waits.
    if let Some(session_tx) = session_tx.lock().unwrap().take() {
        let _ = session_tx.send(Err(error
            .clone()
            .unwrap_or_else(|| "acp connection ended before session creation".to_string())));
    }
    if let Some(runner) = runner.upgrade() {
        *runner.tx.lock().await = None;
    }

    let final_session_id = session_id.lock().unwrap().clone();
    resolve_all_permissions_cancelled(&pending, &agent_id, &sink);

    let mut event = AcpStreamEvent::new(&agent_id, final_session_id, STAGE_STOPPED);
    event.error = error;
    sink.emit(event);
}

/// Everything a parked connection needs to (re)create the session after a
/// successful sign-in.
#[derive(Clone)]
struct SessionContext {
    cwd: PathBuf,
    mcp_servers: Vec<McpServer>,
    /// Session to resume via `session/load` instead of creating a new one.
    resume_session_id: Option<String>,
    load_session_supported: bool,
    capabilities: AcpAgentCapsView,
    session_id: Arc<StdMutex<String>>,
    agent_info: Option<AcpAgentInfoView>,
}

/// Establishes the session: resumes via `session/load` when requested and
/// supported (falling back to a fresh session if the resume fails), otherwise
/// sends `session/new`. Records the session id for the eventual `stopped`
/// event. AUTH_REQUIRED bubbles up so the sign-in flow can run first.
async fn establish_session(
    connection: &ConnectionTo<Agent>,
    context: &SessionContext,
) -> Result<AcpStartInfo, agent_client_protocol::Error> {
    if let Some(resume_id) = context
        .resume_session_id
        .as_ref()
        .filter(|_| context.load_session_supported)
    {
        let loaded = connection
            .send_request(
                LoadSessionRequest::new(SessionId::new(resume_id.clone()), context.cwd.clone())
                    .mcp_servers(context.mcp_servers.clone()),
            )
            .block_task()
            .await;
        match loaded {
            Ok(response) => {
                *context.session_id.lock().unwrap() = resume_id.clone();
                return Ok(AcpStartInfo {
                    session_id: Some(resume_id.clone()),
                    auth_required: false,
                    auth_methods: Vec::new(),
                    resumed: true,
                    capabilities: Some(context.capabilities.clone()),
                    modes: response.modes.as_ref().map(modes_view),
                    config_options: response.config_options.clone(),
                    agent_info: context.agent_info.clone(),
                });
            }
            Err(error) if is_auth_required_error(&error) => return Err(error),
            Err(_) => {
                // The agent no longer knows this session (pruned history,
                // different backend state); fall through to a fresh session
                // and let the frontend report the downgrade via `resumed`.
            }
        }
    }

    let session: NewSessionResponse = connection
        .send_request(
            NewSessionRequest::new(context.cwd.clone())
                .mcp_servers(context.mcp_servers.clone()),
        )
        .block_task()
        .await?;
    let created_session_id = session.session_id.to_string();
    *context.session_id.lock().unwrap() = created_session_id.clone();
    Ok(AcpStartInfo {
        session_id: Some(created_session_id),
        auth_required: false,
        auth_methods: Vec::new(),
        resumed: false,
        capabilities: Some(context.capabilities.clone()),
        modes: session.modes.as_ref().map(modes_view),
        config_options: session.config_options.clone(),
        agent_info: context.agent_info.clone(),
    })
}

fn is_auth_required_error(error: &agent_client_protocol::Error) -> bool {
    matches!(error.code, ErrorCode::AuthRequired)
        || error.message.to_lowercase().contains("authentication required")
}

/// Parks on the request channel until it closes (runner stopped) or the
/// transport dies. Prompt, set-mode, and authenticate turns are spawned onto
/// the connection so a `session/cancel` can be delivered while a turn is
/// still in flight (sign-in can take minutes in a browser).
async fn park_loop(
    connection: ConnectionTo<Agent>,
    rx: &mut mpsc::UnboundedReceiver<SessionRequest>,
    context: SessionContext,
) {
    while let Some(request) = rx.recv().await {
        match request {
            SessionRequest::Prompt {
                session_id,
                content,
                reply,
            } => {
                let sent = connection
                    .send_request(PromptRequest::new(SessionId::new(session_id), content));
                let _ = connection.spawn(async move {
                    let result = sent
                        .block_task()
                        .await
                        .map(|response| AcpPromptResult {
                            stop_reason: enum_wire_name(&response.stop_reason),
                        })
                        .map_err(|e| e.to_string());
                    let _ = reply.send(result);
                    Ok(())
                });
            }
            SessionRequest::Cancel { session_id, reply } => {
                let result = connection
                    .send_notification(CancelNotification::new(SessionId::new(session_id)))
                    .map_err(|e| e.to_string());
                let _ = reply.send(result);
            }
            SessionRequest::SetMode {
                session_id,
                mode_id,
                reply,
            } => {
                let sent = connection.send_request(SetSessionModeRequest::new(
                    SessionId::new(session_id),
                    SessionModeId::new(mode_id),
                ));
                let _ = connection.spawn(async move {
                    let result = sent.block_task().await.map(|_| ()).map_err(|e| e.to_string());
                    let _ = reply.send(result);
                    Ok(())
                });
            }
            SessionRequest::SetConfigOption {
                session_id,
                config_id,
                value,
                reply,
            } => {
                let sent = connection.send_request(SetSessionConfigOptionRequest::new(
                    SessionId::new(session_id),
                    SessionConfigId::new(config_id),
                    value,
                ));
                let _ = connection.spawn(async move {
                    let result = sent
                        .block_task()
                        .await
                        .map(|response: SetSessionConfigOptionResponse| response.config_options)
                        .map_err(|e| e.to_string());
                    let _ = reply.send(result);
                    Ok(())
                });
            }
            SessionRequest::Authenticate { method_id, reply } => {
                let connection_for_auth = connection.clone();
                let context = context.clone();
                let _ = connection.spawn(async move {
                    let result = async {
                        connection_for_auth
                            .send_request(AuthenticateRequest::new(method_id))
                            .block_task()
                            .await
                            .map_err(|e| e.to_string())?;
                        establish_session(&connection_for_auth, &context)
                            .await
                            .map_err(|e| e.to_string())
                    }
                    .await;
                    let _ = reply.send(result);
                    Ok(())
                });
            }
        }
    }
}

/// Resolves every parked permission request as `Cancelled` and notifies the
/// frontend. Used on turn cancellation and connection teardown.
fn resolve_all_permissions_cancelled(
    pending: &PendingPermissions,
    agent_id: &str,
    sink: &Arc<dyn EventSink>,
) {
    let drained: Vec<(String, PendingPermission)> =
        pending.lock().unwrap().drain().collect();
    for (request_id, pending_permission) in drained {
        let _ = pending_permission
            .responder
            .respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        let mut event = AcpStreamEvent::new(
            agent_id,
            pending_permission.session_id,
            STAGE_PERMISSION_RESOLVED,
        );
        event.permission_resolution = Some(AcpPermissionResolutionView {
            request_id,
            option_id: None,
            cancelled: true,
        });
        sink.emit(event);
    }
}

/// Serves `fs/read_text_file` on behalf of the agent.
async fn read_text_file(request: &ReadTextFileRequest) -> Result<String, String> {
    let content = tokio::fs::read_to_string(&request.path)
        .await
        .map_err(|e| format!("read {}: {e}", request.path.display()))?;
    if request.line.is_none() && request.limit.is_none() {
        return Ok(content);
    }
    let skip = request.line.map(|line| line.saturating_sub(1) as usize).unwrap_or(0);
    let lines = content.lines().skip(skip);
    let sliced: Vec<&str> = match request.limit {
        Some(limit) => lines.take(limit as usize).collect(),
        None => lines.collect(),
    };
    Ok(sliced.join("\n"))
}

/// Serves `fs/write_text_file` on behalf of the agent.
async fn write_text_file(request: &WriteTextFileRequest) -> Result<(), String> {
    if let Some(parent) = request.path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&request.path, &request.content)
        .await
        .map_err(|e| format!("write {}: {e}", request.path.display()))
}

/// Translates one typed SDK notification into frontend stream events.
pub fn translate_notification(
    agent_id: &str,
    notification: &SessionNotification,
) -> Vec<AcpStreamEvent> {
    let session_id = notification.session_id.to_string();
    let mut event = AcpStreamEvent::new(agent_id, session_id, STAGE_DELTA);

    match &notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            let text = content_block_text(&chunk.content);
            if text.is_empty() {
                return Vec::new();
            }
            event.chunk = Some(text);
        }
        // User-message chunks arrive when an agent replays history during
        // `session/load`; the panel uses them to rebuild the transcript.
        SessionUpdate::UserMessageChunk(chunk) => {
            let text = content_block_text(&chunk.content);
            if text.is_empty() {
                return Vec::new();
            }
            event.stage = STAGE_USER;
            event.chunk = Some(text);
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = content_block_text(&chunk.content);
            if text.is_empty() {
                return Vec::new();
            }
            event.stage = STAGE_THOUGHT;
            event.chunk = Some(text);
        }
        SessionUpdate::ToolCall(call) => {
            event.stage = STAGE_TOOL_CALL;
            event.tool_call = Some(tool_call_view(call));
        }
        SessionUpdate::ToolCallUpdate(update) => {
            event.stage = STAGE_TOOL_UPDATE;
            event.tool_call = Some(tool_call_update_view(update));
        }
        SessionUpdate::Plan(plan) => {
            event.stage = STAGE_PLAN;
            event.plan = Some(plan_view(plan));
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            event.stage = STAGE_COMMANDS;
            event.commands = Some(update.available_commands.iter().map(command_view).collect());
        }
        SessionUpdate::CurrentModeUpdate(update) => {
            event.stage = STAGE_MODE;
            event.current_mode_id = Some(update.current_mode_id.to_string());
        }
        // Agents push the *full* option set on every change, so the frontend
        // replaces rather than merges.
        SessionUpdate::ConfigOptionUpdate(update) => {
            event.stage = STAGE_CONFIG_OPTIONS;
            event.config_options = Some(update.config_options.clone());
        }
        SessionUpdate::UsageUpdate(update) => {
            event.stage = STAGE_USAGE;
            event.usage = Some(usage_view(update));
        }
        // Session-info/config-option updates are accepted but not surfaced.
        _ => return Vec::new(),
    }
    vec![event]
}

fn tool_call_view(call: &ToolCall) -> AcpToolCallView {
    AcpToolCallView {
        tool_call_id: call.tool_call_id.to_string(),
        title: Some(call.title.clone()),
        kind: Some(enum_wire_name(&call.kind).unwrap_or_else(|| "other".to_string())),
        status: Some(enum_wire_name(&call.status).unwrap_or_else(|| "pending".to_string())),
        content: Some(call.content.iter().map(tool_content_view).collect()),
        locations: Some(call.locations.iter().map(tool_location_view).collect()),
        raw_input: call.raw_input.clone(),
        raw_output: call.raw_output.clone(),
    }
}

fn tool_call_update_view(update: &ToolCallUpdate) -> AcpToolCallView {
    let fields = &update.fields;
    AcpToolCallView {
        tool_call_id: update.tool_call_id.to_string(),
        title: fields.title.clone(),
        kind: fields.kind.as_ref().and_then(enum_wire_name),
        status: fields.status.as_ref().and_then(enum_wire_name),
        content: fields
            .content
            .as_ref()
            .map(|content| content.iter().map(tool_content_view).collect()),
        locations: fields
            .locations
            .as_ref()
            .map(|locations| locations.iter().map(tool_location_view).collect()),
        raw_input: fields.raw_input.clone(),
        raw_output: fields.raw_output.clone(),
    }
}

fn tool_content_view(content: &agent_client_protocol::schema::v1::ToolCallContent) -> AcpToolContentView {
    use agent_client_protocol::schema::v1::ToolCallContent;
    match content {
        ToolCallContent::Content(inner) => AcpToolContentView::Text {
            text: content_block_text(&inner.content),
        },
        ToolCallContent::Diff(diff) => AcpToolContentView::Diff {
            path: diff.path.to_string_lossy().to_string(),
            old_text: diff.old_text.clone(),
            new_text: diff.new_text.clone(),
        },
        ToolCallContent::Terminal(terminal) => AcpToolContentView::Terminal {
            terminal_id: terminal.terminal_id.to_string(),
        },
        _ => AcpToolContentView::Text {
            text: String::new(),
        },
    }
}

fn tool_location_view(location: &ToolCallLocation) -> AcpToolLocationView {
    AcpToolLocationView {
        path: location.path.to_string_lossy().to_string(),
        line: location.line,
    }
}

fn plan_view(plan: &Plan) -> Vec<AcpPlanEntryView> {
    plan.entries
        .iter()
        .map(|entry| AcpPlanEntryView {
            content: entry.content.clone(),
            priority: enum_wire_name(&entry.priority).unwrap_or_else(|| "medium".to_string()),
            status: enum_wire_name(&entry.status).unwrap_or_else(|| "pending".to_string()),
        })
        .collect()
}

fn command_view(command: &AvailableCommand) -> AcpCommandView {
    let input_hint = command.input.as_ref().and_then(|input| match input {
        AvailableCommandInput::Unstructured(unstructured) => Some(unstructured.hint.clone()),
        _ => None,
    });
    AcpCommandView {
        name: command.name.clone(),
        description: command.description.clone(),
        input_hint,
    }
}

fn usage_view(update: &UsageUpdate) -> AcpUsageView {
    AcpUsageView {
        used: update.used,
        size: update.size,
    }
}

fn permission_option_view(option: &PermissionOption) -> AcpPermissionOptionView {
    AcpPermissionOptionView {
        option_id: option.option_id.to_string(),
        name: option.name.clone(),
        kind: enum_wire_name(&option.kind).unwrap_or_else(|| "allow_once".to_string()),
    }
}

fn auth_method_view(method: &AuthMethod) -> AcpAuthMethodView {
    AcpAuthMethodView {
        id: method.id().to_string(),
        name: method.name().to_string(),
        description: method.description().map(str::to_string),
    }
}

fn modes_view(modes: &SessionModeState) -> AcpModesView {
    AcpModesView {
        current_mode_id: modes.current_mode_id.to_string(),
        available_modes: modes
            .available_modes
            .iter()
            .map(|mode| AcpModeView {
                id: mode.id.to_string(),
                name: mode.name.clone(),
                description: mode.description.clone(),
            })
            .collect(),
    }
}

/// Serializes a schema enum to its wire name (`in_progress`, `end_turn`, …),
/// staying robust as the `#[non_exhaustive]` enums grow.
fn enum_wire_name<T: Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
}

/// Extracts renderable text from a content block; resource links become
/// markdown links, other non-text blocks contribute nothing.
fn content_block_text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        ContentBlock::ResourceLink(link) => format!("[{}]({})", link.name, link.uri),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        ContentChunk, CurrentModeUpdate, PlanEntry, PlanEntryPriority, PlanEntryStatus, SessionId,
        ToolCallId, ToolKind,
    };

    fn notification(update: SessionUpdate) -> SessionNotification {
        SessionNotification::new(SessionId::new("test-session"), update)
    }

    #[test]
    fn message_chunk_becomes_delta_event() {
        let notification = notification(SessionUpdate::AgentMessageChunk(ContentChunk::new(
            ContentBlock::Text(TextContent::new("hello".to_string())),
        )));
        let events = translate_notification("codex", &notification);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stage, STAGE_DELTA);
        assert_eq!(events[0].chunk.as_deref(), Some("hello"));
        assert_eq!(events[0].agent_id, "codex");
    }

    #[test]
    fn thought_chunk_becomes_thought_event() {
        let notification = notification(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
            ContentBlock::Text(TextContent::new("pondering".to_string())),
        )));
        let events = translate_notification("codex", &notification);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stage, STAGE_THOUGHT);
        assert_eq!(events[0].chunk.as_deref(), Some("pondering"));
    }

    #[test]
    fn tool_call_becomes_tool_event_with_wire_names() {
        let notification = notification(SessionUpdate::ToolCall(
            ToolCall::new(ToolCallId::from("t1"), "run ls".to_string()).kind(ToolKind::Execute),
        ));
        let events = translate_notification("codex", &notification);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stage, STAGE_TOOL_CALL);
        let view = events[0].tool_call.as_ref().unwrap();
        assert_eq!(view.tool_call_id, "t1");
        assert_eq!(view.title.as_deref(), Some("run ls"));
        assert_eq!(view.kind.as_deref(), Some("execute"));
        assert_eq!(view.status.as_deref(), Some("pending"));
    }

    #[test]
    fn plan_update_becomes_plan_event() {
        let notification = notification(SessionUpdate::Plan(Plan::new(vec![PlanEntry::new(
            "step one",
            PlanEntryPriority::High,
            PlanEntryStatus::InProgress,
        )])));
        let events = translate_notification("codex", &notification);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stage, STAGE_PLAN);
        let plan = events[0].plan.as_ref().unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].content, "step one");
        assert_eq!(plan[0].priority, "high");
        assert_eq!(plan[0].status, "in_progress");
    }

    #[test]
    fn mode_update_becomes_mode_event() {
        let notification = notification(SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(
            SessionModeId::new("yolo"),
        )));
        let events = translate_notification("codex", &notification);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stage, STAGE_MODE);
        assert_eq!(events[0].current_mode_id.as_deref(), Some("yolo"));
    }

    #[test]
    fn session_info_updates_are_ignored() {
        let notification = notification(SessionUpdate::SessionInfoUpdate(Default::default()));
        let events = translate_notification("codex", &notification);
        assert!(events.is_empty());
    }

    #[test]
    fn auth_required_error_is_detected_by_code_and_message() {
        let by_code = agent_client_protocol::Error::auth_required();
        assert!(is_auth_required_error(&by_code));

        let by_message = agent_client_protocol::Error::new(-32603, "Authentication required");
        assert!(is_auth_required_error(&by_message));

        let other = agent_client_protocol::Error::new(-32603, "boom");
        assert!(!is_auth_required_error(&other));
    }

    #[test]
    fn auth_method_view_maps_id_name_description() {
        use agent_client_protocol::schema::v1::AuthMethodAgent;
        let method = AuthMethod::Agent(
            AuthMethodAgent::new("chatgpt", "Sign in with ChatGPT")
                .description("Opens a browser".to_string()),
        );
        let view = auth_method_view(&method);
        assert_eq!(view.id, "chatgpt");
        assert_eq!(view.name, "Sign in with ChatGPT");
        assert_eq!(view.description.as_deref(), Some("Opens a browser"));
    }
}
