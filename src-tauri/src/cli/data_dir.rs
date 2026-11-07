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

/// Files that mark a directory as an eShell data directory.
///
/// Used to tell "this is the desktop app's configuration" from a coincidental
/// `.eshell-data` folder, so the executable-relative guess never picks up an
/// empty or unrelated directory.
const DATA_DIR_MARKERS: &[&str] = &[
    "ssh_configs.json",
    "known_hosts.json",
    "scripts.json",
    "acp_agents.json",
    "projects.json",
    "ai_profiles.json",
];

/// Whether `path` is a directory that holds eShell configuration.
fn looks_like_data_dir(path: &Path) -> bool {
    path.is_dir() && DATA_DIR_MARKERS.iter().any(|name| path.join(name).is_file())
}

/// The data directory of an eShell installed alongside this executable.
///
/// The installer puts the app at `<install>\eshell.exe` and the tools at
/// `<install>\cli\`, with the configuration in `<install>\.eshell-data`. The
/// tools can therefore find the app's data from their own path — no flag, no
/// environment variable, no pointer file. Both layouts are checked: a tool run
/// from `cli\` (installed) and a tool dropped next to the app (portable).
fn sibling_data_dir(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    for base in [Some(dir), dir.parent()].into_iter().flatten() {
        let candidate = base.join(DATA_DIR_NAME);
        if looks_like_data_dir(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Resolves the data directory.
///
/// Precedence, highest first:
/// 1. the `--data-dir` flag,
/// 2. the `ESHELL_DATA_DIR` environment variable,
/// 3. `<working directory>/.eshell-data`, when it exists — this is the layout
///    the desktop app uses, so a tool run from the same directory sees the
///    same profiles,
/// 4. the data directory of an eShell installed next to this executable
///    (`<install>/.eshell-data`), so an installed app and its `cli\` tools
///    agree without any configuration,
/// 5. the per-user configuration directory.
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
    // The installer's layout: the tools live in `cli\` beside the app, whose
    // configuration sits in `.eshell-data` one or two levels up.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = sibling_data_dir(&exe) {
            return found;
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

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eshell-data-dir-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// The installed layout: `<install>\eshell.exe` + `<install>\cli\eshell-cli.exe`
    /// + `<install>\.eshell-data`. The tool finds the app's configuration from
    /// its own path.
    #[test]
    fn the_installed_layout_is_found_from_the_executable() {
        let root = temp_root("installed");
        let cli_dir = root.join("cli");
        std::fs::create_dir_all(&cli_dir).expect("create cli dir");

        // An empty `.eshell-data` is not evidence of anything.
        std::fs::create_dir_all(root.join(DATA_DIR_NAME)).expect("create data dir");
        assert_eq!(sibling_data_dir(&cli_dir.join("eshell-cli.exe")), None);

        std::fs::write(root.join(DATA_DIR_NAME).join("ssh_configs.json"), "[]")
            .expect("seed a marker");
        assert_eq!(
            sibling_data_dir(&cli_dir.join("eshell-cli.exe")),
            Some(root.join(DATA_DIR_NAME))
        );
    }

    /// A tool copied next to the app instead of into `cli\` finds the same
    /// directory.
    #[test]
    fn a_tool_beside_the_app_finds_the_same_directory() {
        let root = temp_root("beside");
        std::fs::create_dir_all(root.join(DATA_DIR_NAME)).expect("create data dir");
        std::fs::write(root.join(DATA_DIR_NAME).join("projects.json"), "[]").expect("seed a marker");

        assert_eq!(
            sibling_data_dir(&root.join("eshell-cli.exe")),
            Some(root.join(DATA_DIR_NAME))
        );
    }

    /// Anywhere else, the guess finds nothing and the caller falls back to the
    /// per-user directory.
    #[test]
    fn an_unrelated_location_has_no_sibling_directory() {
        let root = temp_root("unrelated");
        assert_eq!(sibling_data_dir(&root.join("eshell-cli.exe")), None);
    }
}
