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

use crate::common::error::{to_command_error, AppError, AppResult};
use crate::domain::extensions::consts::*;
use crate::domain::sftp::model::{
    SftpCancelTransferInput, SftpCreateInput, SftpDeleteInput, SftpDownloadInput,
    SftpDownloadToLocalInput, SftpListInput, SftpReadInput, SftpRenameInput,
    SftpUploadLocalWithProgressInput, SftpWriteInput,
};
use crate::domain::monitor::model::FetchServerStatusInput;
use crate::domain::ssh::model::session_model::{CloseShellInput, ExecuteCommandInput, OpenShellInput};
use crate::domain::sftp::service::{
    self as sftp_service, download as sftp_download, files as sftp_files, paths as sftp_paths,
    upload as sftp_upload,
};
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
pub(crate) struct NoArgs {}

/// `get_cached_server_status`'s legacy flat shape `{ sessionId }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdArgs {
    pub(crate) session_id: String,
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
    let _lease = crate::domain::extensions::service::lifecycle::require_plugin_active(state, &input.extension_id)?;
    dispatch(state, app, &input.command, input.args).await
}

#[derive(Deserialize)]
struct CommandInput<T> {
    input: T,
}

/// Mirrors Tauri's named-argument decoding before deserializing domain input.
/// Most commands receive `{ input: ... }`, not the domain struct at the root.
pub(crate) fn parse_args<T: DeserializeOwned>(command: &str, args: &Value) -> AppResult<T> {
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
                crate::domain::ssh::service::session::open_shell_session(
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
                crate::domain::ssh::service::session::close_shell_session(state, &input.session_id)?,
            )?
        }
        "execute_shell_command" => {
            let input: ExecuteCommandInput = parse_args(command, &args)?;
            to_value(
                crate::domain::ssh::service::session::execute_command(
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
            to_value(sftp_files::sftp_list_dir(state, Some(app), input).await?)?
        }
        "sftp_read_file" => {
            let input: SftpReadInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_read_file(state, Some(app), input).await?)?
        }
        "sftp_write_file" => {
            let input: SftpWriteInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_write_file(state, Some(app), input).await?)?
        }
        "sftp_create_file" => {
            let input: SftpCreateInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_create_file(state, Some(app), input).await?)?
        }
        "sftp_create_directory" => {
            let input: SftpCreateInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_create_directory(state, Some(app), input).await?)?
        }
        "sftp_delete_entry" => {
            let input: SftpDeleteInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_delete_entry(state, Some(app), input).await?)?
        }
        "sftp_rename_entry" => {
            let input: SftpRenameInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_rename_entry(state, Some(app), input).await?)?
        }
        "sftp_download_file" => {
            let input: SftpDownloadInput = parse_args(command, &args)?;
            to_value(sftp_files::sftp_download_file(state, Some(app), input).await?)?
        }
        "sftp_download_file_to_local" => {
            let input: SftpDownloadToLocalInput = parse_args(command, &args)?;
            to_value(
                sftp_download::sftp_download_file_to_local(state, app, input).await?,
            )?
        }
        "sftp_upload_local_file_with_progress" => {
            let input: SftpUploadLocalWithProgressInput = parse_args(command, &args)?;
            to_value(
                sftp_upload::sftp_upload_local_file_with_progress(state, app, input).await?,
            )?
        }
        "sftp_cancel_transfer" => {
            let input: SftpCancelTransferInput = parse_args(command, &args)?;
            to_value(sftp_service::cancel_transfer(state, &input.transfer_id))?
        }
        "sftp_default_download_dir" => {
            let _args: NoArgs = parse_args(command, &args)?;
            to_value(sftp_paths::default_download_dir())?
        }

        // ---- status -------------------------------------------------------
        "fetch_server_status" => {
            let input: FetchServerStatusInput = parse_args(command, &args)?;
            to_value(
                crate::domain::monitor::service::fetch_server_status_inner(state, Some(app), input).await?,
            )?
        }
        "get_cached_server_status" => {
            // Legacy flat shape, preserved verbatim.
            let input: SessionIdArgs = parse_args(command, &args)?;
            to_value(crate::domain::monitor::service::get_cached_status(
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
                    let file = crate::domain::config::ConfigFile::parse(name)?;
                    to_value(vec![state.storage.reload_config(file)])?
                }
                None => to_value(state.storage.reload_all_configs())?,
            }
        }
        "list_reloadable_configs" => {
            let _args: NoArgs = parse_args(command, &args)?;
            to_value(crate::domain::config::command::reloadable_configs())?
        }

        _ => {
            return Err(AppError::Validation(format!(
                "command {command:?} is not available to extensions"
            )));
        }
    };
    Ok(value)
}

pub(crate) fn to_value<T: serde::Serialize>(value: T) -> AppResult<Value> {
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

