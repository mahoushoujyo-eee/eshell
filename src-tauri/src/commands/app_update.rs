//! Version reporting and release lookup for the Settings → Version tab.
//!
//! This checks GitHub Releases directly rather than going through
//! `tauri-plugin-updater`: the project ships no updater signing key and its CI
//! produces no `latest.json`/`.sig` artifacts, so a signature-verified in-app
//! install is not available. What is available is telling the user a newer
//! version exists and handing them the installer for their platform.

use serde::Serialize;

/// Release feed for the published builds.
const RELEASES_API: &str = "https://api.github.com/repos/mahoushoujyo-eee/eshell/releases/latest";

/// GitHub rejects API requests without one.
const USER_AGENT: &str = concat!("eshell/", env!("CARGO_PKG_VERSION"));

const REQUEST_TIMEOUT_SECS: u64 = 15;

/// One downloadable installer from a release.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub name: String,
    pub download_url: String,
    pub size: u64,
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
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| format!("could not reach the release feed: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "the release feed answered {}",
            response.status().as_u16()
        ));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|err| format!("could not read the release feed: {err}"))?;

    let latest = normalize_version(&release.tag_name);
    let update_available = is_newer(&latest, &current);

    Ok(ReleaseCheck {
        current_version: current,
        latest_version: Some(latest),
        update_available,
        release_url: Some(release.html_url),
        release_notes: release.body.filter(|body| !body.trim().is_empty()),
        published_at: release.published_at,
        asset: pick_platform_asset(&release.assets),
    })
}

#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(serde::Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
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

/// Picks the installer for the running platform.
///
/// Extensions are matched in preference order, so a Windows release that ships
/// both an `.msi` and an NSIS `-setup.exe` yields the msi.
fn pick_platform_asset(assets: &[GithubAsset]) -> Option<ReleaseAsset> {
    let preferred: &[&str] = if cfg!(target_os = "windows") {
        &[".msi", "-setup.exe"]
    } else if cfg!(target_os = "macos") {
        &[".dmg", ".app.tar.gz"]
    } else {
        &[".AppImage", ".deb", ".rpm"]
    };

    preferred.iter().find_map(|suffix| {
        assets
            .iter()
            .find(|asset| {
                asset
                    .name
                    .to_ascii_lowercase()
                    .ends_with(&suffix.to_ascii_lowercase())
            })
            .map(|asset| ReleaseAsset {
                name: asset.name.clone(),
                download_url: asset.browser_download_url.clone(),
                size: asset.size,
            })
    })
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

    fn asset(name: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.invalid/{name}"),
            size: 42,
        }
    }

    #[test]
    fn pick_platform_asset_prefers_the_native_installer() {
        let assets = vec![
            asset("eshell_1.5.2_amd64.deb"),
            asset("eshell_1.5.2_x64-setup.exe"),
            asset("eshell_1.5.2_x64_en-US.msi"),
            asset("eshell_1.5.2_aarch64.dmg"),
            asset("eshell_1.5.2_amd64.AppImage"),
        ];

        let picked = pick_platform_asset(&assets).expect("an installer for this platform");
        if cfg!(target_os = "windows") {
            // msi wins over the NSIS setup when a release ships both.
            assert!(picked.name.ends_with(".msi"), "{}", picked.name);
        } else if cfg!(target_os = "macos") {
            assert!(picked.name.ends_with(".dmg"), "{}", picked.name);
        } else {
            assert!(picked.name.ends_with(".AppImage"), "{}", picked.name);
        }
    }

    #[test]
    fn pick_platform_asset_returns_nothing_when_the_release_has_no_match() {
        let assets = vec![asset("eshell-sources.tar.bz2"), asset("checksums.txt")];
        assert!(pick_platform_asset(&assets).is_none());
    }
}
