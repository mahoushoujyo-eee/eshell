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

use super::sftp;
use super::status;

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

/// The tools each plugin contributes, in the order the default
/// `tools/list` exposed them before the migration.
///
/// Order matters: SFTP tools precede the status tool, matching the
/// pre-migration list (`read_remote_file`, `write_remote_file`,
/// `list_remote_dir`, `get_server_status`).
fn sftp_tools() -> Vec<PluginTool> {
    vec![
        PluginTool {
            definition: tool(
                "read_remote_file",
                "Read a text file from the remote server of an open session via SFTP.",
                json!({
                    "sessionId": session_id_property(),
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
                    "sessionId": session_id_property(),
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
                    "sessionId": session_id_property(),
                    "path": {"type": "string", "description": "Absolute remote directory path"},
                }),
                &["sessionId", "path"],
            ),
            handler: sftp::mcp_list_remote_dir,
        },
    ]
}

fn status_tools() -> Vec<PluginTool> {
    vec![PluginTool {
        definition: tool(
            "get_server_status",
            "Fetch live CPU, memory, disk, network, and top-process metrics for the remote server of an open session.",
            json!({ "sessionId": session_id_property() }),
            &["sessionId"],
        ),
        handler: status::mcp_get_server_status,
    }]
}

/// The plugin-contributed tool definitions, filtered by activation.
///
/// An inactive plugin contributes nothing: its tools disappear from
/// `tools/list` exactly as if it had never registered.
pub(crate) fn plugin_tool_definitions(state: &Arc<AppState>) -> Vec<Value> {
    let mut definitions = Vec::new();
    if sftp::is_active(state) {
        definitions.extend(sftp_tools().into_iter().map(|tool| tool.definition));
    }
    if status::is_active(state) {
        definitions.extend(status_tools().into_iter().map(|tool| tool.definition));
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
        let mut tools = sftp_tools();
        if status::is_active(state) {
            tools.extend(status_tools());
        }
        tools
    } else if status::is_active(state) {
        status_tools()
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

fn session_id_property() -> Value {
    json!({
        "type": "string",
        "description": "Shell session id from list_shell_sessions",
    })
}

pub(crate) fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing or empty argument `{key}`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-plugin-tools-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Arc::new(AppState::new(root).expect("create test state"))
    }

    /// The pre-migration default `tools/list`, captured from git HEAD
    /// (`mcp_bridge::tool_definitions` before this refactor) as a golden
    /// value. Names, order, schemas and descriptions must match exactly.
    #[test]
    fn default_tools_list_matches_the_pre_migration_golden() {
        let state = test_state();
        let tools = plugin_tool_definitions(&state);
        // Only the plugin-contributed tail: core tools are asserted by the
        // bridge's own golden test.
        let golden = serde_json::from_str::<Value>(PRE_MIGRATION_PLUGIN_TOOLS_JSON)
            .expect("parse golden json");
        assert_eq!(
            serde_json::to_value(&tools).expect("serialize"),
            golden,
            "plugin tool definitions must match the pre-migration list"
        );
    }

    /// Order is part of the contract: SFTP tools precede the status tool.
    #[test]
    fn plugin_tools_keep_the_pre_migration_order() {
        let state = test_state();
        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(
            names,
            [
                "read_remote_file",
                "write_remote_file",
                "list_remote_dir",
                "get_server_status"
            ]
        );
    }

    /// Deactivating a plugin removes exactly its tools, keeping the rest.
    #[test]
    fn deactivating_a_plugin_removes_only_its_tools() {
        let state = test_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable sftp");

        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(names, ["get_server_status"]);

        state
            .extensions()
            .set_enabled("eshell.server-monitor", false)
            .expect("disable status");
        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert!(names.is_empty());

        // Re-enabling restores the full ordered list.
        state
            .extensions()
            .set_enabled("eshell.sftp", true)
            .expect("enable sftp");
        state
            .extensions()
            .set_enabled("eshell.server-monitor", true)
            .expect("enable status");
        let tools = plugin_tool_definitions(&state);
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert_eq!(
            names,
            [
                "read_remote_file",
                "write_remote_file",
                "list_remote_dir",
                "get_server_status"
            ]
        );
    }

    /// Calling a deactivated plugin's tool reports the unknown-tool error,
    /// matching the pre-migration semantics of an unregistered name.
    #[tokio::test]
    async fn calling_a_deactivated_plugins_tool_reports_unknown_tool() {
        let state = test_state();
        state
            .extensions()
            .set_enabled("eshell.sftp", false)
            .expect("disable sftp");

        let outcome = dispatch_plugin_tool(
            &state,
            "read_remote_file",
            &serde_json::json!({"sessionId": "s", "path": "/"}),
        )
        .await;
        assert!(
            outcome.is_none(),
            "a deactivated plugin's tool must be unknown"
        );

        // An active plugin's tool still routes and reports its own errors
        // (here: the missing session) inside the result, not as None.
        let outcome = dispatch_plugin_tool(
            &state,
            "get_server_status",
            &serde_json::json!({"sessionId": "missing-session"}),
        )
        .await
        .expect("the status tool must route");
        assert!(
            outcome.is_err(),
            "the missing session must be an in-result error"
        );
    }

    /// The plugin tool JSON exactly as `tools/list` exposed it before the
    /// migration (git HEAD: `server_ops::sftp` + `server_ops::status` tools).
    /// Captured from the pre-migration `tool_definitions()` output; do not
    /// regenerate from the current implementation.
    const PRE_MIGRATION_PLUGIN_TOOLS_JSON: &str = r#"[
  {
    "name": "read_remote_file",
    "description": "Read a text file from the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote path"
        }
      },
      "required": [
        "sessionId",
        "path"
      ]
    }
  },
  {
    "name": "write_remote_file",
    "description": "Write (create or overwrite) a text file on the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote path"
        },
        "content": {
          "type": "string",
          "description": "Full file content to write"
        }
      },
      "required": [
        "sessionId",
        "path",
        "content"
      ]
    }
  },
  {
    "name": "list_remote_dir",
    "description": "List a directory on the remote server of an open session via SFTP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        },
        "path": {
          "type": "string",
          "description": "Absolute remote directory path"
        }
      },
      "required": [
        "sessionId",
        "path"
      ]
    }
  },
  {
    "name": "get_server_status",
    "description": "Fetch live CPU, memory, disk, network, and top-process metrics for the remote server of an open session.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Shell session id from list_shell_sessions"
        }
      },
      "required": [
        "sessionId"
      ]
    }
  }
]"#;
}
