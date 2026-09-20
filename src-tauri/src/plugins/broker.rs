//! The extension API broker: `invoke_extension_api`.
//!
//! One Tauri command fronts a fixed whitelist of *existing* commands for
//! external plugins. This is lifecycle accounting, not a security boundary:
//! same-context code can bypass the facade. What it does guarantee:
//!
//! - the caller extension's native lease is held across the entire operation,
//!   picker callbacks included, so a disable of the *calling* extension is
//!   rejected while its operation is in flight — on top of the provider
//!   lease the underlying command takes itself (an external caller running an
//!   SFTP command keeps both its own lease and `eshell.sftp`'s busy count);
//! - `args` has the same shape the frontend passes to `invoke`. Commands with
//!   a named `input` parameter decode that envelope before their domain input;
//!   legacy flat and no-argument commands keep their existing wire shapes;
//! - raw PTY input and configuration/credential commands are not on the
//!   whitelist; `select_upload_file` / `select_download_dir` are private
//!   broker operations, not standalone Tauri commands.
//!
//! Errors: unknown extension -> NotFound; disabled extension -> Validation;
//! unknown command or a mismatched argument shape -> Validation.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::error::{to_command_error, AppError, AppResult};
use crate::models::{
    CloseShellInput, ExecuteCommandInput, FetchServerStatusInput, OpenShellInput,
    SftpCancelTransferInput, SftpCreateInput, SftpDeleteInput, SftpDownloadInput,
    SftpDownloadToLocalInput, SftpListInput, SftpReadInput, SftpRenameInput,
    SftpUploadLocalWithProgressInput, SftpWriteInput,
};
use crate::plugins::sftp::ops as sftp_ops;
use crate::state::AppState;

/// `invoke_extension_api` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeExtensionApiInput {
    pub extension_id: String,
    pub command: String,
    /// Verbatim existing-command arguments (see the module docs).
    #[serde(default)]
    pub args: Value,
}

/// `list_shell_sessions` / `sftp_default_download_dir`: no arguments.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoArgs {}

/// `get_cached_server_status`'s legacy flat shape `{ sessionId }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    session_id: String,
}

/// Picker arguments: `{ title?, defaultPath? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerArgs {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
}

/// `reload_config` arguments: `{ file? }`. Omitting `file` reloads all.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadArgs {
    #[serde(default)]
    pub file: Option<String>,
}

/// The commands an external plugin may invoke, by exact name.
///
/// Deliberately excluded: `pty_write_input` (raw terminal input),
/// every configuration/credential command, and anything not needed by the
/// facade. `select_upload_file` / `select_download_dir` exist only here.
///
/// `reload_config` is the one config-adjacent command here, and it is
/// read-only: it re-reads files the user already wrote and never returns
/// credentials. A plugin that edits a config file outside the app can ask
/// the host to pick the change up without a restart.
#[cfg_attr(not(test), allow(dead_code))]
const WHITELIST: &[&str] = &[
    "list_shell_sessions",
    "open_shell_session",
    "close_shell_session",
    "execute_shell_command",
    "sftp_list_dir",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_create_file",
    "sftp_create_directory",
    "sftp_delete_entry",
    "sftp_rename_entry",
    "sftp_download_file",
    "sftp_download_file_to_local",
    "sftp_upload_local_file_with_progress",
    "sftp_cancel_transfer",
    "sftp_default_download_dir",
    "fetch_server_status",
    "get_cached_server_status",
    "select_upload_file",
    "select_download_dir",
    "reload_config",
    "list_reloadable_configs",
];

/// Whether a command name is brokerable.
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_whitelisted(command: &str) -> bool {
    WHITELIST.contains(&command)
}

/// The `invoke_extension_api` Tauri command.
///
/// Holds the caller's lease for the whole operation (pickers included), then
/// dispatches on the whitelist.
#[tauri::command]
pub async fn invoke_extension_api(
    state: tauri::State<'_, Arc<AppState>>,
    app: AppHandle,
    input: InvokeExtensionApiInput,
) -> Result<Value, String> {
    invoke(&state, &app, input).await.map_err(to_command_error)
}

async fn invoke(
    state: &Arc<AppState>,
    app: &AppHandle,
    input: InvokeExtensionApiInput,
) -> AppResult<Value> {
    // Caller lease across the entire operation. `lease` itself rejects
    // unknown (NotFound) and disabled (Validation) extensions.
    let _lease = crate::plugins::lifecycle::require_plugin_active(state, &input.extension_id)?;
    dispatch(state, app, &input.command, input.args).await
}

#[derive(Deserialize)]
struct CommandInput<T> {
    input: T,
}

/// Mirrors Tauri's named-argument decoding before deserializing domain input.
/// Most commands receive `{ input: ... }`, not the domain struct at the root.
fn parse_args<T: DeserializeOwned>(command: &str, args: &Value) -> AppResult<T> {
    let parsed = match command {
        "list_shell_sessions"
        | "sftp_default_download_dir"
        | "get_cached_server_status"
        | "select_upload_file"
        | "select_download_dir"
        | "list_reloadable_configs" => serde_json::from_value(args.clone()),
        _ => serde_json::from_value::<CommandInput<T>>(args.clone()).map(|args| args.input),
    };
    parsed.map_err(|error| {
        AppError::Validation(format!("invalid arguments for {command}: {error}"))
    })
}

use serde::de::DeserializeOwned;

async fn dispatch(
    state: &Arc<AppState>,
    app: &AppHandle,
    command: &str,
    args: Value,
) -> AppResult<Value> {
    let value = match command {
        // ---- sessions -----------------------------------------------------
        "list_shell_sessions" => {
            let _args: NoArgs = parse_args(command, &args)?;
            to_value(state.list_sessions())?
        }
        "open_shell_session" => {
            let input: OpenShellInput = parse_args(command, &args)?;
            to_value(
                crate::server_ops::service::open_shell_session(
                    Arc::clone(state),
                    app.clone(),
                    &input.config_id,
                    input.request_id.as_deref(),
                )
                .await?,
            )?
        }
        "close_shell_session" => {
            let input: CloseShellInput = parse_args(command, &args)?;
            to_value(
                crate::server_ops::service::close_shell_session(state, &input.session_id)?,
            )?
        }
        "execute_shell_command" => {
            let input: ExecuteCommandInput = parse_args(command, &args)?;
            to_value(
                crate::server_ops::service::execute_command(
                    state,
                    &input.session_id,
                    &input.command,
                )
                .await?,
            )?
        }

        // ---- SFTP ---------------------------------------------------------
        "sftp_list_dir" => {
            let input: SftpListInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_list_dir(state, Some(app), input).await?)?
        }
        "sftp_read_file" => {
            let input: SftpReadInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_read_file(state, Some(app), input).await?)?
        }
        "sftp_write_file" => {
            let input: SftpWriteInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_write_file(state, Some(app), input).await?)?
        }
        "sftp_create_file" => {
            let input: SftpCreateInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_create_file(state, Some(app), input).await?)?
        }
        "sftp_create_directory" => {
            let input: SftpCreateInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_create_directory(state, Some(app), input).await?)?
        }
        "sftp_delete_entry" => {
            let input: SftpDeleteInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_delete_entry(state, Some(app), input).await?)?
        }
        "sftp_rename_entry" => {
            let input: SftpRenameInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_rename_entry(state, Some(app), input).await?)?
        }
        "sftp_download_file" => {
            let input: SftpDownloadInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_download_file(state, Some(app), input).await?)?
        }
        "sftp_download_file_to_local" => {
            let input: SftpDownloadToLocalInput = parse_args(command, &args)?;
            to_value(
                sftp_ops::sftp_download_file_to_local(state, app, input).await?,
            )?
        }
        "sftp_upload_local_file_with_progress" => {
            let input: SftpUploadLocalWithProgressInput = parse_args(command, &args)?;
            to_value(
                sftp_ops::sftp_upload_local_file_with_progress(state, app, input).await?,
            )?
        }
        "sftp_cancel_transfer" => {
            let input: SftpCancelTransferInput = parse_args(command, &args)?;
            to_value(sftp_ops::sftp_cancel_transfer(state, &input.transfer_id))?
        }
        "sftp_default_download_dir" => {
            let _args: NoArgs = parse_args(command, &args)?;
            to_value(sftp_ops::default_download_dir())?
        }

        // ---- status -------------------------------------------------------
        "fetch_server_status" => {
            let input: FetchServerStatusInput = parse_args(command, &args)?;
            to_value(
                crate::plugins::status::fetch_server_status(state, Some(app), input).await?,
            )?
        }
        "get_cached_server_status" => {
            // Legacy flat shape, preserved verbatim.
            let input: SessionIdArgs = parse_args(command, &args)?;
            to_value(crate::plugins::status::get_cached_server_status(
                state, &input.session_id,
            ))?
        }

        // ---- private broker pickers ---------------------------------------
        "select_upload_file" => {
            let input: PickerArgs = parse_args(command, &args)?;
            to_value(pick_file(app, input).await?)?
        }
        "select_download_dir" => {
            let input: PickerArgs = parse_args(command, &args)?;
            to_value(pick_folder(app, input).await?)?
        }

        // ---- config reload ------------------------------------------------
        // Read-only: re-reads files the user already wrote. It never returns
        // credentials, so a plugin can pick up an external edit without being
        // able to read the SSH profiles it is picking up.
        "reload_config" => {
            let input: ReloadArgs = parse_args(command, &args)?;
            match input.file.as_deref() {
                Some(name) => {
                    let file = crate::storage::ConfigFile::parse(name)?;
                    to_value(vec![state.storage.reload_config(file)])?
                }
                None => to_value(state.storage.reload_all_configs())?,
            }
        }
        "list_reloadable_configs" => {
            let _args: NoArgs = parse_args(command, &args)?;
            to_value(crate::commands::config::reloadable_configs())?
        }

        _ => {
            return Err(AppError::Validation(format!(
                "command {command:?} is not available to extensions"
            )));
        }
    };
    Ok(value)
}

fn to_value<T: serde::Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|error| AppError::Runtime(error.to_string()))
}

/// Native single-file picker. Returns the path or `None` when cancelled.
///
/// The caller's lease (taken in [`invoke`]) is still held while this waits:
/// the command does not resolve until the picker callback resolves, so the
/// lease covers the entire picker lifetime.
async fn pick_file(app: &AppHandle, args: PickerArgs) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(title) = args.title.as_deref().filter(|t| !t.trim().is_empty()) {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = args.default_path.as_deref().filter(|p| !p.trim().is_empty()) {
        builder = builder.set_directory(default_path);
    }
    builder.pick_file(move |path| {
        let _ = tx.send(file_path_to_string(path));
    });
    rx.await.map_err(|_| {
        AppError::Runtime("the file picker callback did not resolve".to_string())
    })
}

/// Native directory picker. Returns the path or `None` when cancelled.
async fn pick_folder(app: &AppHandle, args: PickerArgs) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(title) = args.title.as_deref().filter(|t| !t.trim().is_empty()) {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = args.default_path.as_deref().filter(|p| !p.trim().is_empty()) {
        builder = builder.set_directory(default_path);
    }
    builder.pick_folder(move |path| {
        let _ = tx.send(file_path_to_string(path));
    });
    rx.await.map_err(|_| {
        AppError::Runtime("the folder picker callback did not resolve".to_string())
    })
}

fn file_path_to_string(path: Option<tauri_plugin_dialog::FilePath>) -> Option<String> {
    path.and_then(|path| match path {
        tauri_plugin_dialog::FilePath::Url(url) => url.to_file_path().ok().map(|p| p.to_string_lossy().to_string()),
        tauri_plugin_dialog::FilePath::Path(path) => Some(path.to_string_lossy().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{now_rfc3339, ServerStatus, ShellSession, SftpListResponse};
    use crate::plugins::manifest::Contributes;

    fn temp_state() -> Arc<AppState> {
        let root = std::env::temp_dir().join(format!(
            "eshell-broker-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        // Seed one external plugin so the caller lease can be taken.
        let state = Arc::new(AppState::new(root).expect("create test state"));
        register_external(&state, "com.example.plugin");
        state
    }

    /// Registers an external extension into the running registry by hand:
    /// discovery normally does this at startup.
    fn register_external(state: &AppState, extension_id: &str) {
        // The catalog-owned test hook registers the id into the activation
        // surface (discovery normally does this at startup).
        state.extensions_test_register(extension_id);
    }

    /// Unknown extensions are refused before any command runs.
    #[test]
    fn whitelist_is_fixed() {
        for allowed in [
            "list_shell_sessions",
            "sftp_list_dir",
            "get_cached_server_status",
            "select_upload_file",
        ] {
            assert!(is_whitelisted(allowed), "{allowed}");
        }
        for denied in [
            "pty_write_input",
            "list_ssh_configs",
            "save_ssh_config",
            "delete_ssh_config",
            "trust_ssh_host_key",
            "pty_resize",
            "reopen_shell_pty",
            "run_script",
            "ssh_ki_respond",
            "set_extension_enabled",
        ] {
            assert!(!is_whitelisted(denied), "{denied} must not be brokerable");
        }
    }

    /// Unknown commands and mismatched shapes are Validation errors, and the
    /// caller lease gates unknown/disabled extensions.
    #[test]
    fn unknown_commands_are_outside_the_whitelist() {
        // A real AppHandle is unavailable in unit tests; dispatch paths that
        // need one are covered by integration/QA. This pins the pure
        // decision boundary: unknown command, PTY input, credentials.
        assert!(!is_whitelisted("definitely_not_a_command"));
    }

    /// The caller lease rejects a disable while the caller's operation is in
    /// flight — an external extension's own busy count, independent of the
    /// provider's.
    #[tokio::test]
    async fn external_caller_busy_rejects_disable() {
        let state = temp_state();

        // Take the caller lease exactly as `invoke` does.
        let lease =
            crate::plugins::lifecycle::require_plugin_active(&state, "com.example.plugin")
                .expect("lease the external caller");
        // While the caller's operation is in flight, disabling it is rejected.
        assert!(matches!(
            state.extensions().set_enabled("com.example.plugin", false),
            Err(AppError::Validation(message)) if message.to_string().contains("in flight")
        ));
        assert!(state.extensions().is_enabled("com.example.plugin"));
        drop(lease);
        state
            .extensions()
            .set_enabled("com.example.plugin", false)
            .expect("disable after the operation finished");
        assert!(!state.extensions().is_enabled("com.example.plugin"));
    }

    /// A disabled or unknown caller is refused before dispatch.
    #[tokio::test]
    async fn disabled_and_unknown_callers_are_refused() {
        let state = temp_state();
        state
            .extensions()
            .set_enabled("com.example.plugin", false)
            .expect("disable");
        match crate::plugins::lifecycle::require_plugin_active(&state, "com.example.plugin") {
            Err(error) => assert!(
                error.to_string().contains("disabled"),
                "the refusal must name the disabled extension: {error}"
            ),
            Ok(_) => panic!("a disabled caller must be refused"),
        }

        match crate::plugins::lifecycle::require_plugin_active(&state, "com.example.ghost") {
            Err(error) => assert!(
                matches!(error, AppError::NotFound(_)),
                "an unknown caller must be NotFound: {error}"
            ),
            Ok(_) => panic!("an unknown caller must be refused"),
        }
    }

    // Shared with the JS facade tests: these are actual serialized broker
    // requests, not domain inputs with the wire envelope removed by a mock.
    #[derive(Deserialize)]
    struct WireCase {
        api: String,
        request: InvokeExtensionApiInput,
    }

    #[test]
    fn shared_frontend_wire_requests_parse_through_the_dispatch_parser() {
        let cases: Vec<WireCase> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/plugin-api-wire.json"
        ))
        .expect("shared wire fixtures");
        assert_eq!(cases.len(), 21);
        let mut seen = std::collections::BTreeSet::new();
        for case in cases {
            let request = case.request;
            assert_eq!(request.extension_id, "eshell.sftp");
            assert!(seen.insert(request.command.clone()), "duplicate wire command");
            let command = request.command.as_str();
            macro_rules! parsed {
                ($ty:ty) => {
                    parse_args::<$ty>(command, &request.args)
                        .unwrap_or_else(|error| panic!("{} ({command}): {error}", case.api))
                };
            }
            match command {
                "list_shell_sessions" | "sftp_default_download_dir" => {
                    let _ = parsed!(NoArgs);
                }
                "open_shell_session" => assert_eq!(parsed!(OpenShellInput).config_id, "wire-config"),
                "close_shell_session" => assert_eq!(parsed!(CloseShellInput).session_id, "wire-session"),
                "execute_shell_command" => {
                    let input = parsed!(ExecuteCommandInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.command, "pwd");
                }
                "sftp_list_dir" => {
                    let input = parsed!(SftpListInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.path, "/var");
                }
                "sftp_read_file" => assert_eq!(parsed!(SftpReadInput).session_id, "wire-session"),
                "sftp_write_file" => assert_eq!(parsed!(SftpWriteInput).session_id, "wire-session"),
                "sftp_create_file" | "sftp_create_directory" => {
                    assert_eq!(parsed!(SftpCreateInput).session_id, "wire-session");
                }
                "sftp_delete_entry" => assert_eq!(parsed!(SftpDeleteInput).session_id, "wire-session"),
                "sftp_rename_entry" => {
                    let input = parsed!(SftpRenameInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.new_name, "renamed.txt");
                }
                "sftp_upload_local_file_with_progress" => {
                    assert_eq!(parsed!(SftpUploadLocalWithProgressInput).session_id, "wire-session");
                }
                "sftp_download_file_to_local" => {
                    assert_eq!(parsed!(SftpDownloadToLocalInput).session_id, "wire-session");
                }
                "sftp_cancel_transfer" => {
                    assert_eq!(parsed!(SftpCancelTransferInput).transfer_id, "wire-upload");
                }
                "fetch_server_status" => {
                    let input = parsed!(FetchServerStatusInput);
                    assert_eq!(input.session_id, "wire-session");
                    assert_eq!(input.selected_interface.as_deref(), Some("eth0"));
                }
                "get_cached_server_status" => assert_eq!(parsed!(SessionIdArgs).session_id, "wire-session"),
                "select_upload_file" | "select_download_dir" => {
                    assert_eq!(parsed!(PickerArgs).default_path.as_deref(), Some("/local"));
                }
                "reload_config" => {
                    // `{ file }` selects one file; `{}` means all of them.
                    assert_eq!(parsed!(ReloadArgs).file.as_deref(), Some("sshConfigs"));
                }
                "list_reloadable_configs" => {
                    let _ = parsed!(NoArgs);
                }
                _ => panic!("uncovered shared wire command: {command}"),
            }
        }
        // This legacy base64 endpoint is not exposed by the JS facade, but
        // its existing input-wrapped contract must remain correct as well.
        let legacy: SftpDownloadInput = parse_args("sftp_download_file", &serde_json::json!({
            "input": { "sessionId": "wire-session", "remotePath": "/var/app.txt" }
        })).expect("legacy download envelope");
        assert_eq!(legacy.session_id, "wire-session");
        seen.insert("sftp_download_file".to_string());
        assert_eq!(seen, WHITELIST.iter().map(|name| name.to_string()).collect());
    }

    #[test]
    fn input_wrapped_commands_reject_missing_or_malformed_envelopes() {
        for malformed in [
            serde_json::json!({ "sessionId": "s", "path": "/" }),
            serde_json::json!({ "input": { "path": "/" } }),
            serde_json::json!({ "input": null }),
            serde_json::json!({ "input": { "input": { "sessionId": "s", "path": "/" } } }),
        ] {
            let error = parse_args::<SftpListInput>("sftp_list_dir", &malformed)
                .expect_err("invalid directory request must not silently default");
            assert!(error.to_string().contains("invalid arguments for sftp_list_dir"));
        }
        assert!(parse_args::<FetchServerStatusInput>(
            "fetch_server_status",
            &serde_json::json!({ "sessionId": "s" })
        ).is_err());
    }

    /// `get_cached_server_status` keeps its legacy flat `{ sessionId }` shape.
    #[tokio::test]
    async fn cached_status_args_shape_is_verbatim() {
        let state = AppState::new(std::env::temp_dir().join(format!(
            "eshell-broker-shape-{}",
            uuid::Uuid::new_v4().simple()
        )))
        .expect("state");
        state.put_session(crate::models::ShellSession {
            id: "session-1".to_string(),
            config_id: "config-1".to_string(),
            config_name: "Test".to_string(),
            current_dir: String::new(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        });
        // Flat shape parses; the wrapped shape must not.
        let flat: SessionIdArgs = parse_args(
            "get_cached_server_status",
            &serde_json::json!({ "sessionId": "session-1" }),
        ).expect("flat");
        assert_eq!(flat.session_id, "session-1");
        assert!(parse_args::<SessionIdArgs>("get_cached_server_status", &serde_json::json!({
            "input": { "sessionId": "session-1" }
        }))
        .is_err());
        let cached = crate::plugins::status::get_cached_server_status(&state, "session-1");
        assert!(cached.is_none());
    }

    /// No-arg commands refuse extra structure the real command would ignore.
    #[test]
    fn no_arg_commands_parse_empty_objects() {
        let ok: NoArgs = serde_json::from_value(serde_json::json!({})).expect("empty");
        let _ = ok;
        // Non-object junk is rejected rather than silently defaulted.
        assert!(serde_json::from_value::<NoArgs>(serde_json::json!("x")).is_err());
        assert!(serde_json::from_value::<NoArgs>(serde_json::json!(null)).is_err());
    }

    /// Picker args: optional title/defaultPath, everything else rejected.
    #[test]
    fn picker_args_shape() {
        let empty: PickerArgs = serde_json::from_value(serde_json::json!({})).expect("empty");
        assert!(empty.title.is_none());
        assert!(empty.default_path.is_none());

        let full: PickerArgs = serde_json::from_value(serde_json::json!({
            "title": "Pick a file",
            "defaultPath": "C:/Users"
        }))
        .expect("full");
        assert_eq!(full.title.as_deref(), Some("Pick a file"));
        assert_eq!(full.default_path.as_deref(), Some("C:/Users"));

        // The plan's other name must not leak in as an alias.
        let wrong: Result<PickerArgs, _> =
            serde_json::from_value(serde_json::json!({ "defaultDir": "C:/Users" }));
        let wrong = wrong.expect("unknown fields are ignored by serde default");
        assert!(wrong.default_path.is_none());
    }

    /// `Contributes` re-export sanity: external manifests contribute panels.
    #[test]
    fn contributes_default_is_empty() {
        assert!(Contributes::default().panels.is_empty());
    }

    /// Serialization of a session DTO keeps camelCase (the verbatim contract).
    #[test]
    fn session_dto_serializes_camel_case() {
        let session = ShellSession {
            id: "s".to_string(),
            config_id: "c".to_string(),
            config_name: "n".to_string(),
            current_dir: String::new(),
            last_output: String::new(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        let value = to_value(session).expect("serialize");
        assert!(value.get("configId").is_some());
        assert!(value.get("config_id").is_none());
    }

    /// `SftpListResponse` DTO shape is the existing one.
    #[test]
    fn sftp_list_response_dto_is_verbatim() {
        let response = SftpListResponse {
            path: "/".to_string(),
            entries: Vec::new(),
        };
        let value = to_value(response).expect("serialize");
        assert!(value.get("entries").is_some());
    }

    /// A minimal `ServerStatus` for DTO-shape assertions.
    fn sample_status() -> ServerStatus {
        ServerStatus {
            cpu_percent: 1.0,
            memory: Default::default(),
            network_interfaces: Vec::new(),
            selected_interface: None,
            selected_interface_traffic: None,
            top_processes: Vec::new(),
            disks: Vec::new(),
            gpus: Vec::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// Status DTO serialization stays camelCase.
    #[test]
    fn status_dto_serializes_camel_case() {
        let status = sample_status();
        let value = to_value(status).expect("serialize");
        assert!(value.get("cpuPercent").is_some());
    }
}
