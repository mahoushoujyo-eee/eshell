//! Tauri commands for the extension lifecycle.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::common::error::to_command_error;
use crate::domain::extensions::consts::*;
use crate::domain::extensions::ExtensionDescriptor;
use crate::domain::extensions::service::protocol as protocol;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExtensionEnabledInput {
    pub extension_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionInput {
    /// Absolute path to the plugin directory the user picked.
    pub source_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallExtensionInput {
    pub extension_id: String,
}

/// Outcome of an install: the id that was installed and the refreshed
/// catalog, so the caller can render the new row without a second round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionResult {
    pub extension_id: String,
    pub display_name: String,
    pub extensions: Vec<ExtensionDescriptor>,
}

/// One external plugin row for `list_external_plugins`: the manifest fields
/// the frontend already knows, plus `enabled`, `main` and the bundle URL.
///
/// `builtin` is always `false` here; builtin descriptors never grow these
/// fields (they have no bundle).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginDescriptor {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub api_version: i64,
    pub builtin: bool,
    pub default_enabled: bool,
    pub enabled: bool,
    pub main: String,
    pub bundle_url: String,
    pub contributes: crate::domain::extensions::model_manifest::Contributes,
}

/// Lists the merged extensions (builtin + discovered external) with their
/// runtime activation state.
///
/// Metadata comes from `extensions/builtin.json` plus the discovered
/// external manifests; the `enabled` flag is this run's activation, seeded
/// from `extensions/state.json` at startup and persisted on every accepted
/// toggle.
#[tauri::command]
pub fn list_extensions(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ExtensionDescriptor>, String> {
    Ok(state.extensions().descriptors(&state.extensions_catalog()))
}

/// Lists the discovered external plugins with their bundle URLs.
///
/// Only discovered-and-validated plugin directories appear here; a broken
/// manifest was logged and skipped at startup. The UI loader pairs this with
/// [`list_extensions`] for the merged catalog.
#[tauri::command]
pub fn list_external_plugins(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ExternalPluginDescriptor>, String> {
    let catalog = state.extensions_catalog();
    let rows = catalog
        .external
        .iter()
        .map(|plugin| ExternalPluginDescriptor {
            id: plugin.entry.id.clone(),
            display_name: plugin.entry.display_name.clone(),
            version: plugin.entry.version.clone(),
            api_version: plugin.entry.api_version,
            builtin: false,
            default_enabled: plugin.entry.default_enabled,
            enabled: state.extensions().is_enabled(&plugin.entry.id),
            main: plugin.entry.main.clone(),
            bundle_url: protocol::bundle_url(plugin),
            contributes: plugin.entry.contributes.clone(),
        })
        .collect();
    Ok(rows)
}

/// Enables or disables one extension for this application run.
///
/// On success this returns the complete descriptor list (the same shape as
/// [`list_extensions`]) and emits `extensions-changed` with that list, and
/// the change is persisted to `extensions/state.json`.
///
/// Rejections surface as Tauri command errors:
/// - unknown extension id
/// - disabling while an operation is in flight (busy lease)
/// - a failed `state.json` write: the whole transition is rejected, so no
///   flag, cleanup or event is half-committed
///
/// Disabling never closes user SSH sessions; the plugin clears only its own
/// bookkeeping (see [`crate::domain::extensions::service::lifecycle::apply_activation`]).
#[tauri::command]
pub fn set_extension_enabled(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    input: SetExtensionEnabledInput,
) -> Result<Vec<ExtensionDescriptor>, String> {
    // One serialized lifecycle transaction: busy check, persistence, flag
    // update, the disable's plugin cleanup, the descriptor snapshot and the
    // extensions-changed emit all share the registry's critical section, so
    // a concurrent enable or lease serializes behind the whole change
    // instead of slipping between the flag update and the cleanup.
    let extension_id = input.extension_id.clone();
    let enabled = input.enabled;
    let app_handle = app.clone();
    let catalog = state.extensions_catalog();
    state
        .extensions()
        .apply_enabled_with_persist(
            &extension_id,
            enabled,
            &catalog,
            || state.persist_extension_enabled(&extension_id, enabled),
            |descriptors| {
                // Plugin cleanup for an accepted disable, before the
                // snapshot or the emit. A rejected change never gets here.
                crate::domain::extensions::service::lifecycle::apply_activation(&state, &extension_id, enabled);
                let _ = app_handle.emit(EXTENSIONS_CHANGED_EVENT, descriptors);
            },
        )
        .map_err(to_command_error)
}

/// Copies a user-picked plugin directory into `extensions/<id>/` and makes it
/// live without a restart.
///
/// The source directory is validated by the same discovery rules as a startup
/// scan: the manifest must parse, `apiVersion` must match, `builtin` must be
/// false, and `main` must resolve inside the directory. A directory that
/// fails validation is rejected *before* anything is copied, so a bad pick
/// cannot leave a half-installed plugin behind.
///
/// The destination is derived from the manifest id, never from the source
/// directory's name, and the id has already passed the discovery identity
/// rules (no separators, no `..`), so it cannot escape `extensions/`.
///
/// Installing over an existing id replaces it. The old copy is moved aside
/// first and restored if the new copy fails, so a failed replace never
/// destroys a working plugin.
#[tauri::command]
pub fn install_extension(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    input: InstallExtensionInput,
) -> Result<InstallExtensionResult, String> {
    let source = std::path::PathBuf::from(input.source_dir.trim());
    let installed = crate::domain::extensions::service::install::install_from_dir(state.inner(), &source)
        .map_err(to_command_error)?;

    let descriptors = state.extensions().descriptors(&state.extensions_catalog());
    let _ = app.emit(EXTENSIONS_CHANGED_EVENT, &descriptors);
    Ok(InstallExtensionResult {
        extension_id: installed.id,
        display_name: installed.display_name,
        extensions: descriptors,
    })
}

/// Removes an installed external plugin's directory and drops it from the
/// catalog without a restart.
///
/// Refused for a builtin extension (its code ships with the app) and while
/// the plugin holds a busy lease: deleting a directory out from under an
/// in-flight operation would strand it.
///
/// The directory is moved to a temporary sibling and deleted after the
/// catalog swap, so a failed removal leaves the plugin installed rather than
/// half-deleted.
#[tauri::command]
pub fn uninstall_extension(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    input: UninstallExtensionInput,
) -> Result<Vec<ExtensionDescriptor>, String> {
    crate::domain::extensions::service::install::uninstall(state.inner(), &input.extension_id)
        .map_err(to_command_error)?;

    let descriptors = state.extensions().descriptors(&state.extensions_catalog());
    let _ = app.emit(EXTENSIONS_CHANGED_EVENT, &descriptors);
    Ok(descriptors)
}

