//! Resolving the `.eshell-data` directory the standalone tools operate on.
//!
//! The desktop app keeps its configuration in `.eshell-data/` next to the
//! process working directory. A CLI or an MCP server is launched from
//! wherever the agent happens to run, so the directory is resolved by an
//! explicit precedence instead of being implied by the working directory.

use std::path::{Path, PathBuf};

/// Environment variable that overrides the data directory.
pub(crate) const DATA_DIR_ENV: &str = "ESHELL_DATA_DIR";

/// The name of the data directory inside the working directory or the
/// per-user configuration root.
const DATA_DIR_NAME: &str = ".eshell-data";

/// Resolves the data directory.
///
/// Precedence, highest first:
/// 1. the `--data-dir` flag,
/// 2. the `ESHELL_DATA_DIR` environment variable,
/// 3. `<working directory>/.eshell-data`, when it exists — this is the layout
///    the desktop app uses, so a tool run from the same directory sees the
///    same profiles,
/// 4. the per-user configuration directory.
pub(crate) fn resolve(explicit: Option<&Path>) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }
    if let Some(raw) = std::env::var_os(DATA_DIR_ENV) {
        let path = PathBuf::from(raw);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let local = cwd.join(DATA_DIR_NAME);
        if local.is_dir() {
            return local;
        }
    }
    global()
}

/// The per-user data directory, used when nothing more specific applies.
fn global() -> PathBuf {
    config_root().join("eshell").join(DATA_DIR_NAME)
}

/// The platform's per-user configuration root.
fn config_root() -> PathBuf {
    #[cfg(windows)]
    {
        // `%APPDATA%` follows the user's profile redirection, which a
        // hand-built path would not.
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"))
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Application Support")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local").join("share"))
    }
}

/// The user's home directory.
#[allow(dead_code)]
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_directory_wins_over_everything() {
        let explicit = PathBuf::from("/tmp/explicit");
        assert_eq!(resolve(Some(&explicit)), explicit);
    }

    #[test]
    fn the_environment_variable_is_used_when_no_flag_is_given() {
        // The variable is process-global, so the test restores it afterwards.
        let previous = std::env::var_os(DATA_DIR_ENV);
        std::env::set_var(DATA_DIR_ENV, "/tmp/from-env");
        let resolved = resolve(None);
        match previous {
            Some(value) => std::env::set_var(DATA_DIR_ENV, value),
            None => std::env::remove_var(DATA_DIR_ENV),
        }
        assert_eq!(resolved, PathBuf::from("/tmp/from-env"));
    }

    #[test]
    fn the_global_directory_is_under_the_configuration_root() {
        let global = global();
        assert!(global.ends_with(DATA_DIR_NAME), "{global:?}");
        assert!(
            global.starts_with(config_root()),
            "{global:?} must live under {:?}",
            config_root()
        );
    }
}
