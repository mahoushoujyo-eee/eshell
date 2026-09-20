//! Installing and removing external plugins at runtime.
//!
//! Both operations go through the same discovery validation a startup scan
//! uses, then swap in a freshly scanned catalog. The rules that matter:
//!
//! - **Validate before touching the destination.** A directory that fails
//!   discovery is rejected while the source is still the only copy, so a bad
//!   pick never leaves a half-installed plugin behind.
//! - **The destination comes from the manifest id**, never from the source
//!   directory's name. The id has already passed the discovery identity rules
//!   (nonempty, no separators, not `.`/`..`, no control characters), so it
//!   cannot escape `extensions/`.
//! - **Replace is atomic-ish.** An existing directory is moved aside first
//!   and restored if the copy fails, so a failed replace never destroys a
//!   working plugin.
//! - **Removal is refused while the plugin is busy.** Deleting a directory
//!   out from under an in-flight operation would strand it.
//!
//! Installing code is a trust decision the user makes by picking the
//! directory; this module enforces structure, not intent. A plugin runs in
//! the host JS context (see the plugin development guide).

use std::path::{Path, PathBuf};

use crate::common::error::{AppError, AppResult};
use crate::state::AppState;

use super::discovery;

/// What an install produced, for the command's response.
#[derive(Debug)]
pub struct Installed {
    pub id: String,
    pub display_name: String,
}

/// The `extensions/` directory under the storage root.
fn extensions_dir(state: &AppState) -> PathBuf {
    state.storage.data_dir().join("extensions")
}

/// Rejects anything that is not a plausible plugin directory before the
/// expensive validation runs, so the error names the real problem.
fn check_source(source: &Path) -> AppResult<()> {
    if !source.is_dir() {
        return Err(AppError::Validation(format!(
            "{} is not a directory",
            source.display()
        )));
    }
    let manifest = source.join("manifest.json");
    if !manifest.is_file() {
        return Err(AppError::Validation(format!(
            "{} has no manifest.json; pick the plugin directory itself, not a parent or an archive",
            source.display()
        )));
    }
    Ok(())
}

/// Validates one candidate directory with the startup discovery rules and
/// returns its manifest entry.
///
/// `seen_ids` carries the ids already claimed by builtins and by the other
/// installed plugins, so an install cannot introduce a duplicate id.
fn validate_candidate(
    source: &Path,
    seen_ids: &std::collections::BTreeSet<String>,
) -> AppResult<crate::domain::extensions::model_manifest::ExternalExtensionEntry> {
    discovery::validate_plugin_dir(source, seen_ids).map_err(AppError::Validation)
}

/// Copies `source` into `extensions/<id>/` and re-scans.
///
/// Returns the installed plugin's id and display name.
pub fn install_from_dir(state: &AppState, source: &Path) -> AppResult<Installed> {
    check_source(source)?;

    let root = extensions_dir(state);
    std::fs::create_dir_all(&root)?;

    // Reject a source that is already the installed copy: copying a directory
    // onto itself would truncate it.
    let source_canonical = std::fs::canonicalize(source)?;
    let root_canonical = std::fs::canonicalize(&root)?;
    if source_canonical.starts_with(&root_canonical) {
        return Err(AppError::Validation(
            "that directory is already inside the extensions folder".to_string(),
        ));
    }

    // Validate against the ids already taken, so a duplicate is caught here
    // rather than silently shadowing an installed plugin. The id being
    // replaced is excluded: reinstalling over an existing plugin is the
    // upgrade path, not a duplicate.
    let catalog = state.extensions_catalog();
    let replacing = discovery::peek_manifest_id(source);
    let mut seen: std::collections::BTreeSet<String> = catalog
        .builtin
        .extensions
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    for plugin in &catalog.external {
        if Some(&plugin.entry.id) != replacing.as_ref() {
            seen.insert(plugin.entry.id.clone());
        }
    }

    let entry = validate_candidate(source, &seen)?;
    let destination = root.join(&entry.id);

    // Move an existing copy aside instead of deleting it, so a failed copy
    // can put it back.
    let backup = root.join(format!(".{}.replaced", entry.id));
    let _ = std::fs::remove_dir_all(&backup);
    let had_previous = destination.exists();
    if had_previous {
        std::fs::rename(&destination, &backup)?;
    }

    if let Err(error) = copy_dir(source, &destination) {
        // Restore the previous copy; a failed replace must not destroy a
        // working plugin.
        let _ = std::fs::remove_dir_all(&destination);
        if had_previous {
            let _ = std::fs::rename(&backup, &destination);
        }
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&backup);

    // Re-scan so the new plugin is in the catalog before anything can ask
    // whether it is enabled.
    let refreshed = state.rescan_extensions_catalog()?;
    if !refreshed.external.iter().any(|p| p.entry.id == entry.id) {
        // The copy landed but discovery rejected it: report rather than
        // claim success on a plugin that will not load.
        return Err(AppError::Runtime(format!(
            "plugin {} was copied but discovery rejected it; check the manifest and entry module",
            entry.id
        )));
    }

    Ok(Installed {
        id: entry.id,
        display_name: entry.display_name,
    })
}

/// Removes an installed external plugin and re-scans.
pub fn uninstall(state: &AppState, extension_id: &str) -> AppResult<()> {
    let id = extension_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("extension id is required".to_string()));
    }

    let catalog = state.extensions_catalog();
    if catalog.builtin.extensions.iter().any(|e| e.id == id) {
        return Err(AppError::Validation(format!(
            "{id} is a builtin extension; its code ships with the app and cannot be removed"
        )));
    }
    let plugin = catalog
        .external
        .iter()
        .find(|p| p.entry.id == id)
        .ok_or_else(|| AppError::NotFound(format!("extension {id}")))?;

    // Refuse while an operation is in flight: deleting the directory under a
    // running plugin would strand that operation.
    if state.extensions().is_busy(id) {
        return Err(AppError::Validation(format!(
            "extension {id} has an operation in flight; try again once it finishes"
        )));
    }

    // Move it out of `extensions/` first, so the re-scan cannot rediscover
    // it, then delete. The staging path must live OUTSIDE `extensions/`:
    // discovery walks every child directory, so a staging directory left
    // inside would be re-discovered as a plugin.
    let staging = state
        .storage
        .data_dir()
        .join(format!(".{id}.uninstalled"));
    let _ = std::fs::remove_dir_all(&staging);
    if plugin.dir.exists() {
        std::fs::rename(&plugin.dir, &staging)?;
    }

    state.rescan_extensions_catalog()?;
    let _ = std::fs::remove_dir_all(&staging);

    // Forget the persisted activation flag so a later reinstall of the same
    // id starts from its manifest default rather than the old choice.
    state.forget_extension_enabled(id);
    Ok(())
}

/// Recursively copies a directory. Symlinks are copied as-is rather than
/// followed: discovery validates the entry module against the plugin
/// directory, and following a link here would let a copy pull in files from
/// outside the picked directory.
fn copy_dir(from: &Path, to: &Path) -> AppResult<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if file_type.is_symlink() {
            // Copy the link itself; a broken or escaping link is then caught
            // by discovery's canonical-path check, not silently resolved.
            let link = std::fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link, &target)?;
            #[cfg(not(unix))]
            {
                // Windows symlink creation needs a privilege we may not have;
                // skipping the link is safer than copying its target.
                let _ = link;
            }
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
