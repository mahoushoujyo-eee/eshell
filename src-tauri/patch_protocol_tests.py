p = 'src/plugins/protocol.rs'
s = open(p, encoding='utf-8').read()

# 1. Replace the co-located replacement test (asserting the wrong threat)
#    with the redirect test (unix) + in-place recreation test (all platforms).
old_replacement = '''    /// Replacing the plugin directory after discovery must not re-anchor the
    /// trusted root: the stored canonical directory is the only root, so a
    /// directory swapped for one containing `ssh_configs.json` (or the
    /// storage root itself) is refused, and `state.json` stays unreachable.
    #[test]
    fn directory_replacement_after_discovery_is_refused() {
        let (root, catalog) = temp_catalog("replaced-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // Swap the directory: remove it and put a different one in its place,
        // containing files that would be servable if the new location were
        /// re-anchored (json is on the asset allowlist).
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::fs::create_dir_all(&plugin_dir).expect("recreate plugin dir");
        std::fs::write(plugin_dir.join("index.js"), b"export default 2;").expect("entry");
        std::fs::write(
            plugin_dir.join("ssh_configs.json"),
            b"[{\\"host\\":\\"smuggled\\"}]",
        )
        .expect("write would-be smuggled config");
        std::fs::write(
            plugin_dir.join(super::super::discovery::EXTENSION_STATE_FILE),
            "{\\"smuggled\\": true}",
        )
        .expect("write would-be smuggled state");

        // The anchor check refuses the whole directory: no file from the new
        // location is served, not even the fresh entry module.
        for path in [
            "/com.example.plugin/index.js",
            "/com.example.plugin/ssh_configs.json",
            "/com.example.plugin/state.json",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert_eq!(
                response.status(),
                tauri::http::StatusCode::FORBIDDEN,
                "{path}"
            );
            assert!(
                response.body() != b"export default 2;"
                    && response.body() != b"[{\\"host\\":\\"smuggled\\"}]"
                    && response.body() != b"{\\"smuggled\\": true}",
                "{path} must not serve the replaced directory's contents"
            );
        }
    }'''

new_replacement = '''    /// A directory *re-pointed* after discovery is refused: the stored
    /// canonical directory is the only trusted root, and a plugin directory
    /// that no longer resolves to it (removed and recreated as a link to the
    /// storage root, or anywhere else) never has its new target adopted.
    ///
    /// Windows junctions exercise the same check; creating them needs
    /// privileges in tests, so QA covers that platform (the check itself is
    /// platform-shared: `canonicalize` resolves junctions and symlinks alike).
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn redirected_directory_after_discovery_is_refused() {
        let (root, catalog) = temp_catalog("redirected-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // The attacker's target: the storage root, holding ssh_configs.json
        // and state.json that must never become plugin assets.
        std::fs::write(
            root.join("ssh_configs.json"),
            b"[{\\"host\\":\\"storage-root\\"}]",
        )
        .expect("write storage root file");

        // Re-point the plugin directory at it: remove the real directory and
        // put a symlink in its place.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::os::unix::fs::symlink(&root, &plugin_dir).expect("symlink plugin dir");

        // Every request through the re-pointed directory is refused: the
        // anchor check compares the *current* resolved directory against the
        // stored discovery-time root, so the new target is not re-anchored.
        for path in [
            "/com.example.plugin/index.js",
            "/com.example.plugin/ssh_configs.json",
            "/com.example.plugin/state.json",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert_eq!(
                response.status(),
                tauri::http::StatusCode::FORBIDDEN,
                "{path}"
            );
            assert!(
                response.body() != b"[{\\"host\\":\\"storage-root\\"}]",
                "{path} must not serve the redirected target's contents"
            );
        }
    }

    /// In-place content changes do not move the anchor: a directory recreated
    /// at the same canonical location keeps its root, and only files *under
    /// that root* are served. The contract item that matters — the real
    /// `extensions/state.json` living *outside* every plugin directory —
    /// stays unreachable no matter what a plugin directory contains.
    #[test]
    fn in_place_directory_recreation_keeps_the_anchor() {
        let (root, catalog) = temp_catalog("recreated-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // Recreate the directory in place with fresh content.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::fs::create_dir_all(&plugin_dir).expect("recreate plugin dir");
        std::fs::write(plugin_dir.join("index.js"), b"export default 2;").expect("entry");

        // Same canonical location: the anchor holds, the fresh entry serves.
        let response = serve_extension_asset(&catalog, "/com.example.plugin/index.js");
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body(), b"export default 2;");

        // The real extension state file — directly under extensions/, never
        /// inside a plugin directory — is still unreachable: no id resolves to
        // it, and no plugin-root containment can cover it.
        let state_path = root
            .join("extensions")
            .join(super::super::discovery::EXTENSION_STATE_FILE);
        let response = serve_extension_asset(
            &catalog,
            &format!(
                "/com.example.plugin/{}",
                state_path.file_name().unwrap().to_string_lossy()
            ),
        );
        // It is not under the plugin root: 403/404, never 200.
        assert_ne!(response.status(), tauri::http::StatusCode::OK);
    }'''

assert old_replacement in s, "replacement block not found"
s = s.replace(old_replacement, new_replacement)

# 2. Remove the now-duplicated older redirect test.
old_redirect = '''    /// A directory *re-pointed* after discovery (removed and recreated as a
    /// link to somewhere else, e.g. the storage root) is refused by the same
    /// anchor check: the new target is never adopted as the root.
    #[cfg(not(target_os = "windows"))] // symlink creation needs privileges on Windows
    #[test]
    fn redirected_directory_after_discovery_is_refused() {
        let (root, catalog) = temp_catalog("redirected-dir");
        let plugin_dir = root.join("extensions").join("a-plugin-dir");

        // The attacker's target: the storage root, holding ssh_configs.json
        // and state.json that must never become plugin assets.
        std::fs::write(
            root.join("ssh_configs.json"),
            b"[{\\"host\\":\\"storage-root\\"}]",
        )
        .expect("write storage root file");

        // Re-point the plugin directory at it.
        std::fs::remove_dir_all(&plugin_dir).expect("remove plugin dir");
        std::os::unix::fs::symlink(&root, &plugin_dir).expect("symlink plugin dir");

        // Every request through the re-pointed directory is refused.
        for path in [
            "/com.example.plugin/index.js",
            "/com.example.plugin/ssh_configs.json",
        ] {
            let response = serve_extension_asset(&catalog, path);
            assert!(
                response.status() == tauri::http::StatusCode::FORBIDDEN
                    || response.status() == tauri::http::StatusCode::NOT_FOUND,
                "{path}"
            );
            assert_ne!(response.status(), tauri::http::StatusCode::OK, "{path}");
            assert!(
                response.body() != b"[{\\"host\\":\\"storage-root\\"}]",
                "{path} must not serve the redirected target's contents"
            );
        }
    }

'''
assert old_redirect in s, "old redirect block not found"
s = s.replace(old_redirect, '')

open(p, 'w', encoding='utf-8', newline='').write(s)
print("patched")
