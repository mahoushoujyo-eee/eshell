//! Release lookup service.
//!
//! Reads the same `latest.json` the updater plugin installs from, so the tab
//! and the in-app installer can never disagree about what the newest release
//! is. The manifest is a plain release asset, which is what makes it usable
//! here: the GitHub REST API this used to call allows 60 unauthenticated
//! requests per hour *per IP*, so a shared office egress exhausted it and every
//! check failed with `403 rate limit exceeded`.

use crate::domain::app_update::consts::*;
use crate::domain::app_update::model::{ReleaseAsset, ReleaseCheck, UpdaterManifest};

/// Looks up the newest published release and compares it to this build.
pub async fn check_app_update() -> Result<ReleaseCheck, String> {
    let current = current_version();

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

/// The version this build reports, without a leading `v`.
pub(crate) fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The manifest's key for the running platform.
///
/// Tauri names macOS `darwin`, so this cannot be `std::env::consts::OS` alone.
/// An unrecognised pair yields a key no release publishes, which leaves `asset`
/// empty rather than picking a wrong installer.
pub(crate) fn platform_key() -> String {
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
pub(crate) fn file_name_of(url: &str) -> String {
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
pub(crate) fn normalize_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).trim().to_string()
}

/// Compares dotted numeric versions, longest wins on a shared prefix
/// (`1.6.0` > `1.6`). A trailing pre-release suffix (`1.6.0-rc.1`) is ignored
/// for ordering, so a pre-release never counts as newer than its own release.
pub(crate) fn is_newer(candidate: &str, current: &str) -> bool {
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
