//! Transport-agnostic MCP server core.
//!
//! The protocol logic lives here rather than in a transport: [`McpServer`]
//! dispatches one JSON-RPC message against the shared
//! [`crate::state::AppState`] and returns the response object. The loopback
//! HTTP bridge (`mcp_bridge`) and the standalone `eshell-mcp` binary are two
//! transports over this one implementation, so both expose exactly the same
//! tools with the same schemas and the same results.
//!
//! The one thing a transport may vary is how a tool's `sessionId` argument is
//! interpreted. In the desktop app a session is a terminal tab the user
//! opened, so the id is used as-is ([`InAppSessionResolver`]). The standalone
//! server has no tabs: the same argument may name an SSH profile, which is
//! connected on demand and reused afterwards. Tool names, schemas and results
//! are identical either way — only the accepted meaning of `sessionId` and
//! the wording of its description differ.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::domain::agent::consts::*;
use crate::domain::ssh::service as server_ops;
use crate::state::AppState;

/// The `sessionId` description used when the server only serves the sessions
/// the user opened in the desktop app.
pub(crate) const IN_APP_SESSION_DOC: &str = "Shell session id from list_shell_sessions";

/// The `sessionId` description used when the server can open connections on
/// demand, so a profile name is a valid target as well.
pub(crate) const STANDALONE_SESSION_DOC: &str =
    "Session id from list_shell_sessions, or an SSH profile name or id — a named profile is \
     connected on demand and reused for later calls.";

/// The `initialize` instructions for the desktop app's bridge.
///
/// They point the agent at the sessions the user opened, because in the app
/// that is the only way to reach a server.
const IN_APP_INSTRUCTIONS: &str = "This server exposes MCP tools only — it has no resources and \
     no prompts, so empty resource/prompt lists are expected, not a failure. \
     Tools for the servers the user manages in eShell: call read_agent_context \
     once at session start (it returns the user's AGENTS.md instructions and the \
     bundled eshell-config skill), and list_shell_sessions before any server work — \
     commands and file access run inside an existing session opened by the user \
     (identified by sessionId) and execute on that remote server, in the session's \
     current directory. list_ssh_profiles lists the configured servers those \
     sessions belong to.";

/// The `initialize` instructions for the standalone server.
///
/// It has no terminal tabs, so telling the agent to look for one would send it
/// down a dead end: `list_shell_sessions` returns an empty list until a
/// profile is used. The agent is told to list the profiles instead and to name
/// one as the `sessionId`.
const STANDALONE_INSTRUCTIONS: &str = "This server exposes MCP tools only — it has no resources \
     and no prompts, so empty resource/prompt lists are expected, not a failure. \
     Tools for the servers the user manages in eShell: call read_agent_context \
     once at session start (it returns the user's AGENTS.md instructions and the \
     bundled eshell-config skill), then call list_ssh_profiles to see the \
     configured servers. A tool's `sessionId` may name an SSH profile by name or \
     id: the server connects to it on demand and reuses that connection for \
     later calls, so no terminal tab has to be open and list_shell_sessions is \
     not needed.";

/// The future a [`SessionResolver`] returns.
pub(crate) type ResolveFuture<'a> =
    Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// Resolves the `sessionId` argument of a tool call to a live session id.
///
/// The returned id is what the tool handlers receive; the target the caller
/// passed is never seen by the domain layer.
pub(crate) trait SessionResolver: Send + Sync {
    fn resolve<'a>(&'a self, target: &'a str) -> ResolveFuture<'a>;
}

/// The desktop app's resolver: the target is already a session id.
///
/// It performs no lookup, so an unknown id still fails inside the tool
/// handler exactly as it did before the resolver existed.
pub(crate) struct InAppSessionResolver;

impl SessionResolver for InAppSessionResolver {
    fn resolve<'a>(&'a self, target: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move { Ok(target.to_string()) })
    }
}

/// One MCP server: the shared state plus the session-target policy.
pub(crate) struct McpServer {
    state: Arc<AppState>,
    resolver: Arc<dyn SessionResolver>,
    session_doc: &'static str,
    instructions: &'static str,
}

impl McpServer {
    /// The server the desktop app exposes on its loopback bridge.
    pub(crate) fn in_app(state: Arc<AppState>) -> Self {
        Self {
            state,
            resolver: Arc::new(InAppSessionResolver),
            session_doc: IN_APP_SESSION_DOC,
            instructions: IN_APP_INSTRUCTIONS,
        }
    }

    /// A server that can open SSH connections on demand.
    pub(crate) fn standalone(state: Arc<AppState>, resolver: Arc<dyn SessionResolver>) -> Self {
        Self {
            state,
            resolver,
            session_doc: STANDALONE_SESSION_DOC,
            instructions: STANDALONE_INSTRUCTIONS,
        }
    }

    /// The tools this server offers, in wire order.
    pub(crate) fn tool_definitions(&self) -> Vec<Value> {
        let mut tools = vec![
            tool(
                "read_agent_context",
                "Read the user's agent context from eShell: the global AGENTS.md instructions \
                 users write for agents, plus the bundled eshell-config skill (eShell's config \
                 files and server-operation rules) and the eshell-plugin-dev skill (how to \
                 write an eShell external plugin). Call this once at the start of a session \
                 before doing any work.",
                json!({}),
                &[],
            ),
            tool(
                "reload_config",
                "Re-read eShell's config files after editing them outside the app, so the \
                 change takes effect without restarting. Pass `file` for one file \
                 (sshConfigs, acpAgents, scripts, aiProfiles, agentContext) or omit it to \
                 reload all. Returns per-file outcomes: a missing file keeps the current \
                 value, and a file that fails to parse is reported rather than applied. \
                 Reloading does not restart anything — an open SSH session keeps its \
                 connection, and a running agent keeps its spawn settings until restarted.",
                json!({
                    "file": {
                        "type": "string",
                        "description": "One of sshConfigs, acpAgents, scripts, aiProfiles, agentContext. Omit to reload all.",
                    },
                }),
                &[],
            ),
            tool(
                "list_ssh_profiles",
                "List the SSH server profiles configured in eShell (no credentials).",
                json!({}),
                &[],
            ),
            tool(
                "list_shell_sessions",
                "List the currently open eShell terminal sessions. Returns each session's id, \
                 server profile, and current working directory. Other tools operate on these sessions.",
                json!({}),
                &[],
            ),
            tool(
                "execute_command",
                "Run a non-interactive shell command on the remote server of an open session, \
                 in that session's current working directory. Returns stdout, stderr, and exit code. \
                 `cd` updates the session's working directory.",
                json!({
                    "sessionId": session_id_property(self.session_doc),
                    "command": {"type": "string", "description": "Shell command to execute"},
                }),
                &["sessionId", "command"],
            ),
        ];
        tools.extend(
            crate::domain::extensions::service::mcp_tools::plugin_tool_definitions_with_doc(
                &self.state,
                self.session_doc,
            ),
        );
        tools
    }

    /// Dispatches one JSON-RPC request and returns the response object.
    pub(crate) async fn handle(&self, message: &Value) -> Value {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

        let result = match method {
            "initialize" => Ok(initialize_result(&params, self.instructions)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.tool_definitions() })),
            "tools/call" => self.call_tool(&params).await,
            // eShell serves tools only, but a client probing the other primitive
            // families must get a spec-shaped empty list rather than a method-not-
            // found error — agents otherwise report the whole bridge as missing.
            "resources/list" => Ok(json!({ "resources": [] })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            "resources/read" => Err((
                -32602,
                "eShell exposes MCP tools only; it has no resources to read".to_string(),
            )),
            "prompts/get" => Err((
                -32602,
                "eShell exposes MCP tools only; it has no prompts to serve".to_string(),
            )),
            other => Err((-32601, format!("method not found: {other}"))),
        };

        match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": code, "message": message}
            }),
        }
    }

    /// Dispatches one tool call to the plugin that registered it.
    ///
    /// Returns `None` when no plugin owns `name` (an unknown tool), `Some`
    /// otherwise. A deactivated plugin's tools are absent here too, so calling
    /// one reports the same unknown-tool error as before it existed.
    async fn call_plugin_tool(
        &self,
        name: &str,
        args: &Value,
    ) -> Option<Result<Value, String>> {
        crate::domain::extensions::service::mcp_tools::dispatch_plugin_tool(&self.state, name, args)
            .await
    }

    /// The definition of one tool, if this server offers it.
    ///
    /// Read from the live tool list, so a deactivated plugin's tool counts as
    /// unknown — exactly as it did before the resolver existed.
    fn tool_definition(&self, name: &str) -> Option<Value> {
        self.tool_definitions()
            .into_iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
    }

    /// Whether a tool takes a session target, read from its own schema.
    ///
    /// Schema-driven rather than a hand-kept list: a plugin that contributes a
    /// session-scoped tool gets the same resolution for free.
    fn tool_takes_session(&self, name: &str) -> bool {
        self.tool_definition(name)
            .and_then(|tool| tool.get("inputSchema").cloned())
            .and_then(|schema| schema.get("properties").cloned())
            .and_then(|properties| properties.get("sessionId").cloned())
            .is_some()
    }

    async fn call_tool(&self, params: &Value) -> Result<Value, (i32, String)> {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Err((-32602, "tools/call requires params.name".to_string()));
        };
        // An unregistered name is a protocol error, the way it has always
        // been: the client asked for a tool this server does not have.
        if self.tool_definition(name).is_none() {
            return Err((-32602, format!("unknown tool `{name}`")));
        }
        let mut args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));

        // Resolve the session target before dispatch. The desktop app passes
        // the id through; the standalone server may have to connect first.
        //
        // A failed resolution is a tool-level failure, not a protocol error:
        // the call was well formed, the target simply could not be reached,
        // and the agent needs to read *why* — "the profile does not exist" is
        // something it can act on, "-32602 invalid params" is not.
        let resolution = if args.is_object() && self.tool_takes_session(name) {
            match args.get("sessionId").and_then(Value::as_str) {
                Some(target) => Some(self.resolver.resolve(target).await),
                None => None,
            }
        } else {
            None
        };

        let outcome: Result<Value, String> = match resolution {
            Some(Err(message)) => Err(message),
            Some(Ok(session_id)) => {
                args["sessionId"] = Value::String(session_id);
                self.dispatch_tool(name, &args).await
            }
            None => self.dispatch_tool(name, &args).await,
        };

        // Tool-level failures are reported inside the result (isError), not as
        // protocol errors, so the agent can read and react to them.
        Ok(match outcome {
            Ok(value) => json!({
                "content": [{"type": "text", "text": to_bounded_text(&value)}],
                "isError": false,
            }),
            Err(message) => json!({
                "content": [{"type": "text", "text": message}],
                "isError": true,
            }),
        })
    }

    /// Runs one tool by name.
    async fn dispatch_tool(&self, name: &str, args: &Value) -> Result<Value, String> {
        match name {
            "read_agent_context" => read_agent_context(&self.state),
            "reload_config" => reload_config(&self.state, args),
            "list_ssh_profiles" => Ok(list_ssh_profiles(&self.state)),
            "list_shell_sessions" => Ok(list_shell_sessions(&self.state)),
            "execute_command" => execute_command_tool(&self.state, args).await,
            other => match self.call_plugin_tool(other, args).await {
                Some(outcome) => outcome,
                None => Err(format!("unknown tool `{other}`")),
            },
        }
    }
}

/// The `initialize` result, including the instructions an agent reads first.
///
/// The instructions are per-server: the app's bridge serves the sessions the
/// user opened, the standalone server opens connections on demand, and an
/// agent that follows the wrong one of those two ends up looking for something
/// that does not exist.
pub(crate) fn initialize_result(params: &Value, instructions: &str) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(FALLBACK_PROTOCOL_VERSION);
    let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        FALLBACK_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "eshell",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": instructions,
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    })
}

fn session_id_property(doc: &str) -> Value {
    json!({
        "type": "string",
        "description": doc,
    })
}

fn to_bounded_text(value: &Value) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    if text.chars().count() <= MAX_TOOL_TEXT_CHARS {
        return text;
    }
    let truncated: String = text.chars().take(MAX_TOOL_TEXT_CHARS).collect();
    format!(
        "{truncated}\n…[truncated {} chars]",
        text.chars().count() - MAX_TOOL_TEXT_CHARS
    )
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing or empty argument `{key}`"))
}

/// Serves the agent-context tool: the global AGENTS.md plus the bundled
/// skills, so agents pick up the user's instructions without the app
/// injecting them into prompts.
fn read_agent_context(state: &Arc<AppState>) -> Result<Value, String> {
    let global = state
        .storage
        .get_agent_context(None)
        .map_err(|e| e.to_string())?;

    let mut payload = json!({
        "agentsMd": {
            "path": global.path,
            "exists": global.exists,
            "content": global.content,
        },
    });

    for (dir, key) in BUNDLED_SKILLS {
        let path = state
            .storage
            .data_dir()
            .join("agent")
            .join("skills")
            .join(dir)
            .join("SKILL.md");
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        payload[key] = json!({
            "path": path.to_string_lossy(),
            "content": content,
        });
    }

    Ok(payload)
}

/// Re-reads config files edited outside the app.
///
/// The agent edits `.eshell-data/*.json` directly (that is what the
/// eshell-config skill documents), so it needs a way to make the host pick
/// the edit up. Without this the only answer was "restart the app".
fn reload_config(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let outcomes = match args.get("file").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => {
            let file = crate::domain::config::ConfigFile::parse(name).map_err(|e| e.to_string())?;
            vec![state.storage.reload_config(file)]
        }
        _ => state.storage.reload_all_configs(),
    };
    serde_json::to_value(outcomes).map_err(|e| e.to_string())
}

fn list_ssh_profiles(state: &Arc<AppState>) -> Value {
    let profiles: Vec<Value> = state
        .storage
        .list_ssh_configs()
        .into_iter()
        .map(|config| {
            json!({
                "id": config.id,
                "name": config.name,
                "host": config.host,
                "port": config.port,
                "username": config.username,
            })
        })
        .collect();
    json!({ "profiles": profiles })
}

fn list_shell_sessions(state: &Arc<AppState>) -> Value {
    let sessions: Vec<Value> = state
        .list_sessions()
        .into_iter()
        .map(|session| {
            json!({
                "sessionId": session.id,
                "profile": session.config_name,
                "configId": session.config_id,
                "currentDir": session.current_dir,
                "updatedAt": session.updated_at,
            })
        })
        .collect();
    json!({ "sessions": sessions })
}

/// Runs one non-interactive command on a session's server.
///
/// Shared by the MCP tool surface and the `eshell-cli` command line, so both
/// report the same stdout, stderr and exit code for the same session.
pub(crate) async fn execute_command_tool(
    state: &Arc<AppState>,
    args: &Value,
) -> Result<Value, String> {
    let session_id = arg_str(args, "sessionId")?;
    let command = arg_str(args, "command")?;
    let result = server_ops::execute_command(state, &session_id, &command)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
        "currentDir": result.current_dir,
        "durationMs": result.duration_ms,
    }))
}
