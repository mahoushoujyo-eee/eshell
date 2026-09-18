//! Release lookup for the Settings → Version tab.
//!
//! Reads the same `latest.json` the updater plugin installs from, so the tab
//! and the in-app installer can never disagree about what the newest release
//! is. The manifest is a plain release asset, which is what makes it usable
//! here: the GitHub REST API this used to call allows 60 unauthenticated
//! requests per hour *per IP*, so a shared office egress exhausted it and every
//! check failed with `403 rate limit exceeded`.

use std::collections::HashMap;

use serde::Serialize;

/// The updater manifest, published next to the signed installers by the release
/// CI. Must stay in step with the `updater.endpoints` entry in `tauri.conf.json`.
const LATEST_JSON_URL: &str =
    "https://github.com/mahoushoujyo-eee/eshell/releases/latest/download/latest.json";

/// Where a human can read the release this manifest describes.
const RELEASE_PAGE: &str = "https://github.com/mahoushoujyo-eee/eshell/releases/tag";

/// GitHub rejects requests without one.
const USER_AGENT: &str = concat!("eshell/", env!("CARGO_PKG_VERSION"));

const REQUEST_TIMEOUT_SECS: u64 = 15;

/// One downloadable installer from a release.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub name: String,
    pub download_url: String,
}

/// What the Version tab renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCheck {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    /// Installer matching the running platform, when the release has one.
    pub asset: Option<ReleaseAsset>,
}

/// The version this build reports, without a leading `v`.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Looks up the newest published release and compares it to this build.
#[tauri::command]
pub async fn check_app_update() -> Result<ReleaseCheck, String> {
    let current = app_version();

    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|err| format!("could not start the update check: {err}"))?
        .get(LATEST_JSON_URL)
        .send()
        .await
        .map_err(|err| format!("could not reach the release feed: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "the release feed answered {}",
            response.status().as_u16()
        ));
    }

    let manifest: UpdaterManifest = response
        .json()
        .await
        .map_err(|err| format!("could not read the release feed: {err}"))?;

    let latest = normalize_version(&manifest.version);
    let update_available = is_newer(&latest, &current);

    Ok(ReleaseCheck {
        current_version: current,
        latest_version: Some(latest.clone()),
        update_available,
        // Derived rather than fetched: the manifest carries no page URL, and
        // asking the API for it is what made this command rate-limitable.
        release_url: Some(format!("{RELEASE_PAGE}/v{latest}")),
        // The manifest has no release notes. The Version tab hides the section
        // when this is absent.
        release_notes: None,
        published_at: manifest.pub_date,
        asset: manifest.platforms.get(&platform_key()).map(|entry| ReleaseAsset {
            name: file_name_of(&entry.url),
            download_url: entry.url.clone(),
        }),
    })
}

/// The updater manifest the release CI writes.
#[derive(serde::Deserialize)]
struct UpdaterManifest {
    version: String,
    #[serde(default)]
    pub_date: Option<String>,
    #[serde(default)]
    platforms: HashMap<String, UpdaterPlatform>,
}

#[derive(serde::Deserialize)]
struct UpdaterPlatform {
    url: String,
}

/// The manifest's key for the running platform.
///
/// Tauri names macOS `darwin`, so this cannot be `std::env::consts::OS` alone.
/// An unrecognised pair yields a key no release publishes, which leaves `asset`
/// empty rather than picking a wrong installer.
fn platform_key() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return String::new();
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        return String::new();
    };

    format!("{os}-{arch}")
}

/// Last path segment of a download URL, used as the installer's display name.
fn file_name_of(url: &str) -> String {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

/// Strips the `v` release tags carry so it can be compared with the crate version.
fn normalize_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).trim().to_string()
}

/// Compares dotted numeric versions, longest wins on a shared prefix
/// (`1.6.0` > `1.6`). A trailing pre-release suffix (`1.6.0-rc.1`) is ignored
/// for ordering, so a pre-release never counts as newer than its own release.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |value: &str| -> Vec<u64> {
        value
            .split('-')
            .next()
            .unwrap_or_default()
            .split('.')
            .map(|piece| piece.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };

    let (left, right) = (parts(candidate), parts(current));
    if left.is_empty() {
        return false;
    }

    for index in 0..left.len().max(right.len()) {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_version_drops_the_tag_prefix() {
        assert_eq!(normalize_version("v1.5.1"), "1.5.1");
        assert_eq!(normalize_version("V1.5.1"), "1.5.1");
        assert_eq!(normalize_version(" 1.5.1 "), "1.5.1");
    }

    #[test]
    fn is_newer_compares_numerically_not_lexically() {
        assert!(is_newer("1.5.2", "1.5.1"));
        assert!(is_newer("1.6.0", "1.5.9"));
        // The lexical comparison "1.10.0" < "1.9.0" is the trap here.
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("2.0.0", "1.99.99"));

        assert!(!is_newer("1.5.1", "1.5.1"));
        assert!(!is_newer("1.5.0", "1.5.1"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!(!is_newer("", "1.5.1"));
    }

    #[test]
    fn is_newer_treats_a_missing_patch_as_zero() {
        assert!(!is_newer("1.5", "1.5.0"));
        assert!(is_newer("1.5.1", "1.5"));
    }

    /// A pre-release of the version already installed must not be offered.
    #[test]
    fn is_newer_ignores_prerelease_suffixes() {
        assert!(!is_newer("1.5.1-rc.1", "1.5.1"));
        assert!(is_newer("1.6.0-rc.1", "1.5.1"));
    }

    /// The manifest the release CI actually writes, trimmed to two platforms.
    const MANIFEST: &str = r#"{
        "version": "1.5.4",
        "pub_date": "2026-09-18T06:16:32Z",
        "platforms": {
            "windows-x86_64": {
                "url": "https://github.com/o/r/releases/download/v1.5.4/eshell_1.5.4_x64-setup.exe",
                "signature": "sig"
            },
            "darwin-aarch64": {
                "url": "https://github.com/o/r/releases/download/v1.5.4/eshell.app.tar.gz",
                "signature": "sig"
            }
        }
    }"#;

    #[test]
    fn reads_the_updater_manifest() {
        let manifest: UpdaterManifest = serde_json::from_str(MANIFEST).expect("parse manifest");
        assert_eq!(manifest.version, "1.5.4");
        assert_eq!(manifest.pub_date.as_deref(), Some("2026-09-18T06:16:32Z"));
        assert_eq!(manifest.platforms.len(), 2);
    }

    /// A manifest with no `platforms` must still parse: the version check is
    /// the part that matters, and a malformed platform map should not turn a
    /// successful check into an error.
    #[test]
    fn a_manifest_without_platforms_still_parses() {
        let manifest: UpdaterManifest =
            serde_json::from_str(r#"{"version": "1.5.4"}"#).expect("parse manifest");
        assert_eq!(manifest.version, "1.5.4");
        assert!(manifest.platforms.is_empty());
        assert!(manifest.pub_date.is_none());
    }

    #[test]
    fn platform_key_names_macos_darwin() {
        let key = platform_key();
        if cfg!(target_os = "macos") {
            assert!(key.starts_with("darwin-"), "{key}");
        } else if cfg!(target_os = "windows") {
            assert!(key.starts_with("windows-"), "{key}");
        } else if cfg!(target_os = "linux") {
            assert!(key.starts_with("linux-"), "{key}");
        }
    }

    #[test]
    fn file_name_of_reads_the_last_path_segment() {
        assert_eq!(
            file_name_of("https://github.com/o/r/releases/download/v1.5.4/eshell_1.5.4_x64-setup.exe"),
            "eshell_1.5.4_x64-setup.exe"
        );
        assert_eq!(file_name_of("https://example.invalid/a/b/"), "b");
        assert_eq!(file_name_of("https://example.invalid/a/b?token=1"), "b");
    }
}
