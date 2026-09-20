//! Unit tests for the release lookup service.

use crate::domain::app_update::model::UpdaterManifest;
use crate::domain::app_update::service::{
    current_version, file_name_of, is_newer, normalize_version, platform_key,
};

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
