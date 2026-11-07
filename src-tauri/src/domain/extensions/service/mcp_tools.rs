//! MCP tool registry and dispatch for built-in plugins.
//!
//! Each plugin registers its tool *definitions* (name, description, schema)
//! and its *call handler* here. The bridge (`mcp_bridge`) concatenates the
//! core tools with `plugin_tool_definitions` and routes unknown-to-core names
//! through `dispatch_plugin_tool`, so:
//!
//! - The default `tools/list` output (names, order, schemas, descriptions)
//!   is exactly the pre-migration list while both plugins are active.
//! - Deactivating a plugin removes its tools from `tools/list` and makes
//!   `tools/call` on them report the same unknown-tool error as any other
//!   unregistered name — success and error semantics are unchanged.
//!
//! No global bearer or credential is shared with plugins: the handlers take
//! `&Arc<AppState>` and only reach sessions the user already opened, which is
//! the bridge's session authorization boundary.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::state::AppState;

use crate::domain::sftp::service as sftp;
use crate::domain::monitor::service as status;

/// One registered plugin tool.
struct PluginTool {
    definition: Value,
    handler: PluginToolHandler,
}

type PluginToolHandler =
    fn(
        &Arc<AppState>,
        Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>;

/// The `sessionId` description used by the desktop app's bridge.
pub(crate) const DEFAULT_SESSION_DOC: &str = "Shell session id from list_shell_sessions";

/// The tools each plugin contributes, in the order the default
/// `tools/list` exposed them before the migration.
///
/// Order matters: SFTP tools precede the status tool, matching the
/// pre-migration list (`read_remote_file`, `write_remote_file`,
/// `list_remote_dir`, `get_server_status`).
fn sftp_tools(session_doc: &str) -> Vec<PluginTool> {
    vec![
        PluginTool {
            definition: tool(
                "read_remote_file",
                "Read a text file from the remote server of an open session via SFTP.",
                json!({
                    "sessionId": session_id_property(session_doc),
                    "path": {"type": "string", "description": "Absolute remote path"},
                }),
                &["sessionId", "path"],
            ),
            handler: sftp::mcp_read_remote_file,
        },
        PluginTool {
            definition: tool(
                "write_remote_file",
                "Write (create or overwrite) a text file on the remote server of an open session via SFTP.",
                json!({
                    "sessionId": session_id_property(session_doc),
                    "path": {"type": "string", "description": "Absolute remote path"},
                    "content": {"type": "string", "description": "Full file content to write"},
                }),
                &["sessionId", "path", "content"],
            ),
            handler: sftp::mcp_write_remote_file,
        },
        PluginTool {
            definition: tool(
                "list_remote_dir",
                "List a directory on the remote server of an open session via SFTP.",
                json!({
                    "sessionId": session_id_property(session_doc),
                    "path": {"type": "string", "description": "Absolute remote directory path"},
                }),
                &["sessionId", "path"],
            ),
            handler: sftp::mcp_list_remote_dir,
        },
    ]
}

fn status_tools(session_doc: &str) -> Vec<PluginTool> {
    vec![PluginTool {
        definition: tool(
            "get_server_status",
            "Fetch live CPU, memory, disk, network, and top-process metrics for the remote server of an open session.",
            json!({ "sessionId": session_id_property(session_doc) }),
            &["sessionId"],
        ),
        handler: status::mcp_get_server_status,
    }]
}

/// The plugin-contributed tool definitions, filtered by activation.
///
/// An inactive plugin contributes nothing: its tools disappear from
/// `tools/list` exactly as if it had never registered.
#[cfg(test)]
pub(crate) fn plugin_tool_definitions(state: &Arc<AppState>) -> Vec<Value> {
    plugin_tool_definitions_with_doc(state, DEFAULT_SESSION_DOC)
}

/// The plugin-contributed tool definitions with an explicit `sessionId`
/// description.
///
/// The desktop app's bridge describes the argument as a session id; the
/// standalone server also accepts an SSH profile name, so it passes its own
/// wording. Nothing else about the definitions differs.
pub(crate) fn plugin_tool_definitions_with_doc(
    state: &Arc<AppState>,
    session_doc: &str,
) -> Vec<Value> {
    let mut definitions = Vec::new();
    if sftp::is_active(state) {
        definitions.extend(
            sftp_tools(session_doc)
                .into_iter()
                .map(|tool| tool.definition),
        );
    }
    if status::is_active(state) {
        definitions.extend(
            status_tools(session_doc)
                .into_iter()
                .map(|tool| tool.definition),
        );
    }
    definitions
}

/// Routes one tool call to the plugin that owns it.
///
/// Returns `None` when no active plugin owns `name`. A deactivated plugin's
/// tools are absent here, so calling them reports the unknown-tool error —
/// the same semantics as an unregistered name.
pub(crate) async fn dispatch_plugin_tool(
    state: &Arc<AppState>,
    name: &str,
    args: &Value,
) -> Option<Result<Value, String>> {
    let tools: Vec<PluginTool> = if sftp::is_active(state) {
        let mut tools = sftp_tools(DEFAULT_SESSION_DOC);
        if status::is_active(state) {
            tools.extend(status_tools(DEFAULT_SESSION_DOC));
        }
        tools
    } else if status::is_active(state) {
        status_tools(DEFAULT_SESSION_DOC)
    } else {
        Vec::new()
    };

    let tool = tools.into_iter().find(|tool| {
        tool.definition
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|tool_name| tool_name == name)
    })?;
    Some((tool.handler)(state, args.clone()).await)
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

pub(crate) fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing or empty argument `{key}`"))
}

