# Hello Plugin

A ready-to-load external plugin: no npm install, build step, JSX transform, or
separate React bundle is required. `index.js` is browser ESM and imports the
adjacent `message.js` through a relative URL.

## Install

Only install local plugins whose code you trust. They execute in eShell's main
JavaScript context, with access to the same browser and Tauri capabilities as
the application. The API facade is not a sandbox or permission boundary.

1. Close eShell.
2. Copy this **entire directory** to
   `<storage-root>/extensions/com.example.hello/`.
3. Start eShell again. The Hello Plugin panel appears, with a toolbar button that
   hides/shows it.

For the usual `npm run tauri -- dev` invocation, the destination is:

```text
src-tauri/.eshell-data/extensions/com.example.hello/
  manifest.json
  index.js
  message.js
```

The storage root still follows the application's working directory. A packaged
application started elsewhere may use a different `.eshell-data` directory.
Restart the desktop process after adding, deleting or editing plugin files;
plain `npm run dev` in a browser cannot serve the native `plugin://` protocol.

## What it demonstrates

- A manifest declaring an external API-v1 plugin.
- Named `activate(eshell)` and a returned disposer.
- A relative ESM import, served by the native plugin protocol.
- `eshell.sessions.list()` through the host API.
- A controller using the **host React instance** from `eshell.react`.
- A panel and toolbar contribution without modifying eShell source.
- Namespaced JSON storage: activation and click counts survive restarts using
  the same app profile. Disabled plugins do not run `activate` at startup.

Do not bundle a second copy of React or leave `import "react"` unresolved in a
browser module. For this example, React APIs are taken from `eshell.react` inside
`activate`. Larger plugins must emit browser-compatible ESM and ship their own
relative dependencies/assets.

## Disable

Runtime integrations can call the existing `set_extension_enabled` Tauri
command with `{ input: { extensionId: "com.example.hello", enabled: false } }`.
This host management command is not a method on the plugin's public facade.
An in-flight API operation can reject deactivation as busy; finish/cancel that
operation before retrying.

Alternatively, close eShell and edit
`<storage-root>/extensions/state.json`, preserving any other entries:

```json
{
  "com.example.hello": { "enabled": false }
}
```

Set it back to `true` and restart to enable it. Removing the example directory
while eShell is closed removes it from discovery on the next startup.

See [Plugin Development](../../docs/guides/features/plugin_development.md) for
the complete API, lifecycle and trust-model documentation.
