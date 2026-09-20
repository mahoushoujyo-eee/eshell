//! Release lookup data structures: the Version tab response and the
//! updater manifest the release CI writes.

use std::collections::HashMap;

use serde::Serialize;

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

/// The updater manifest the release CI writes.
#[derive(serde::Deserialize)]
pub(crate) struct UpdaterManifest {
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) pub_date: Option<String>,
    #[serde(default)]
    pub(crate) platforms: HashMap<String, UpdaterPlatform>,
}

#[derive(serde::Deserialize)]
pub(crate) struct UpdaterPlatform {
    pub(crate) url: String,
}
