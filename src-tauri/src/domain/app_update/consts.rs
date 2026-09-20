//! Constants for the release lookup service.

/// The updater manifest, published next to the signed installers by the release
/// CI. Must stay in step with the `updater.endpoints` entry in `tauri.conf.json`.
pub(crate) const LATEST_JSON_URL: &str =
    "https://github.com/mahoushoujyo-eee/eshell/releases/latest/download/latest.json";

/// Where a human can read the release this manifest describes.
pub(crate) const RELEASE_PAGE: &str = "https://github.com/mahoushoujyo-eee/eshell/releases/tag";

/// GitHub rejects requests without one.
pub(crate) const USER_AGENT: &str = concat!("eshell/", env!("CARGO_PKG_VERSION"));

pub(crate) const REQUEST_TIMEOUT_SECS: u64 = 15;
