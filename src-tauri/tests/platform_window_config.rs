//! The platform configs exist only to flip `transparent` on Linux and macOS.
//! Because JSON Merge Patch replaces arrays wholesale, each file repeats the
//! whole window object — this test is what keeps the copies from drifting.

use std::path::Path;

fn read(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {name}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

#[test]
fn platform_window_objects_match_the_base_except_for_transparency() {
    let base = read("tauri.conf.json");
    let base_window = &base["app"]["windows"][0];

    for name in ["tauri.linux.conf.json", "tauri.macos.conf.json"] {
        let platform = read(name);
        let window = &platform["app"]["windows"][0];

        assert_eq!(window["transparent"], serde_json::json!(true), "{name}");

        let mut expected = base_window.clone();
        expected["transparent"] = serde_json::json!(true);
        assert_eq!(window, &expected, "{name} window drifted from tauri.conf.json");
    }
}

#[test]
fn the_base_config_asks_for_the_private_transparency_api() {
    // The build script checks the Cargo features against the base config
    // only, so the macOS flag has to live there — the platform files only
    // carry the window.
    let base = read("tauri.conf.json");
    assert_eq!(base["app"]["macOSPrivateApi"], serde_json::json!(true));
}
