# Built-in and External Extensions

SFTP and server monitoring are the first built-in eShell extensions. This is a
behavior-preserving migration: both extensions are enabled by default, and the
existing panels, toolbar order, split layout, translations, settings keys, Tauri
commands, and successful command payloads remain compatible.

## Scope

Feature ownership is separated from the workbench and SSH kernel. In addition
to the original built-in migration, trusted external browser-ESM plugins can now
be discovered from the local extensions directory and loaded through an API-v1
facade. The Settings → Plugins tab installs a plugin from a picked directory,
removes an external one, and toggles either kind; the catalog is re-scanned at
runtime, so those operations do not need a restart. This does not add a
marketplace, a sandbox, a Node runtime, source hot reload, or a new theme. See
[Plugin Development](../features/plugin_development.md) for installation and the
public facade contract.

The native implementations are still statically compiled into the application.
Runtime deactivation withdraws their capabilities; it does not unload a Rust
library or provide process-level isolation. Native implementation updates still
ship with an eShell release.

The legacy `useWorkbench` return shape and Tauri entry points remain compatibility
adapters. Built-in React controllers retain their fixed composition order;
external controllers mount in independently keyed React components, not a dynamic
hook loop. External code is imported only after manifest validation and before
the first application render. Core session actions, settings callbacks, existing
panel markup and current monitoring semantics remain compatibility requirements.

## Ownership

| Area | Owner |
| --- | --- |
| SSH connections, session identity, PTY, command transport, credentials | Core |
| Layout, stable panel slots, shared notices and application context | Workbench |
| Discovery, runtime state, lifecycle and contribution routing | Extension platform |
| SFTP operations, transfer cancellation state, browser/controller | `eshell.sftp` |
| Status probes, parsing, cache, polling/controller | `eshell.server-monitor` |

Implementation roots:

- `extensions/builtin.json`: shared built-in manifest.
- `src-tauri/src/plugins/`: native registry and feature implementations.
- `src/plugins/`: injected API, loader, controllers and contribution registry.
- `<storage-root>/extensions/*/manifest.json`: runtime-discovered external manifests.
- `src/lib/plugin-host.js`: private bridge behind the public plugin facade.
- `src/lib/tauri-api.js`: existing invoke facade plus lifecycle/discovery/broker methods.

The manifest is consumed by both Rust and JavaScript. Each extension declares
its ID, display name, implementation version, API version, default activation
state, and panel contributions. The existing panel IDs are `sftp` and `status`;
these IDs and their order are not renamed during migration.

Feature modules may use the core's SSH transport, but must not create a second
credential store or duplicate the user's connection to make a plugin boundary.
File transfer and status DTOs remain shared contracts, not workbench-owned
feature state.

## Runtime lifecycle API

The host lifecycle/discovery commands are:

- `list_extensions`: returns merged manifest metadata plus `enabled` for each extension.
- `set_extension_enabled`: accepts
  `{ input: { extensionId, enabled } }`, persists the choice, returns the complete
  descriptor list, and emits `extensions-changed` with that list on success.
- `list_external_plugins`: returns validated external descriptors and platform-correct
  `bundleUrl` values for dynamic import through the registered `plugin` protocol.
- `invoke_extension_api`: private whitelisted transport behind the JS facade,
  retaining the caller's native lease for the entire operation. It is not a public
  `invoke` method on the injected API and is not an authentication boundary.
- `install_extension`: accepts `{ input: { sourceDir } }`, validates the picked
  directory with the same rules as a startup scan, copies it to
  `extensions/<manifest id>/`, re-scans the catalog, and emits
  `extensions-changed`. Validation runs before any copy, so a rejected install
  leaves nothing behind; replacing an existing id moves the old copy aside and
  restores it if the copy fails.
- `uninstall_extension`: accepts `{ input: { extensionId } }`, moves the plugin
  directory out of `extensions/`, re-scans, and drops its persisted activation
  flag. Refused for a builtin id and while the plugin holds a busy lease.

The frontend facade exposes `api.listExtensions()`,
`api.setExtensionEnabled(extensionId, enabled)`,
`api.installExtension(sourceDir)`, and `api.uninstallExtension(extensionId)`.

For example, application integration code can temporarily disable monitoring:

```js
await api.setExtensionEnabled("eshell.server-monitor", false);
// Restore the existing monitoring capability and its contributions.
await api.setExtensionEnabled("eshell.server-monitor", true);
```

Activation choices persist in `<storage-root>/extensions/state.json` and override
manifest defaults after restart. A failed state write rejects the transition,
without publishing a successful flag change or event. Existing panel visibility
preferences and feature settings retain their original keys.

Lifecycle rules:

- Repeating the current activation state is harmless.
- Unknown extension IDs reject the command rather than mutating another feature.
- SFTP deactivation is rejected while an operation is in flight. Finish the
  operation, or cancel it through the existing transfer UI and wait for it to
  settle, before retrying.
- Hiding a panel is not extension deactivation and does not cancel transfers.
- Deactivation must not close existing SSH sessions or their PTYs.
- Disabled extensions must not accept new feature operations or contribute
  callable MCP tools.
- Feature-owned listeners and periodic work follow the extension lifecycle.
- In-flight work must not repopulate the state of a later activation.
- A catalog re-scan (install/uninstall) reconciles activation entries without
  changing an existing extension's explicit flag: a disabled plugin stays
  disabled, and a newly discovered one starts at its manifest `defaultEnabled`.
  An id that is busy keeps its entry even if its directory is gone, so an
  in-flight operation is never stranded.

The Settings → Plugins tab is the visible surface for these commands. It lists
the merged catalog, toggles each row, installs from a picked directory, and
removes external plugins behind a confirmation. Builtin rows offer no removal.

## Compatibility boundaries

### UI and frontend behavior

The current component markup and styles are retained. Contributions are routed
to the existing workbench slots, preserving the panel keys, KeepAlive ownership,
SplitPane ratios and constraints, and toolbar ordering. Compatibility imports
may remain while implementation ownership moves to `src/plugins/`.

Default behavior intentionally preserves:

- Status polling when either the SFTP panel or the status panel is visible.
- Immediate initial status refresh, then the configured delay after completion;
  the current serialized polling, batched probes and 20-second budget are retained.
- Cached status first, live status second, with stale-request protection.
- Existing automatic NIC selection and localized transient-failure notices.
- The open file's session identity during tab switches and debounced saves.
- Existing upload-completion directory refresh rules.
- Transfer normalization, progress, cancellation, and the 30-row transfer list.
- Existing `localStorage` keys and defaults.

Changing the polling policy or redesigning a panel is a separate feature change,
not part of this migration.

### Native commands and events

Existing SFTP and status command names, inputs, successful payloads, and
`sftp-transfer` events are unchanged. The command entry points delegate to the
owning enabled extension. Explicit deactivation introduces an unavailable state;
it does not fall back to a hidden implementation in the core.

Status cache writes retain the session-lifetime guard so a closed tab cannot be
resurrected by an old probe. Transfer cancellation retains pre-cancel ordering,
partial-file cleanup, and the existing cancellation messages used by the UI.

### MCP

The bridge collects the SFTP and monitoring tools from the native extension
registry. With both defaults enabled, tool names, descriptions, schemas, ordering,
and operation results remain compatible. Disabled providers withdraw their tools
from discovery and reject invocation. Consumers should refresh `tools/list`
after lifecycle changes; this phase does not introduce a new tool-list change
notification protocol.

The existing local MCP authentication and session boundary remain in place.
The public facade does not expose raw credentials or the bridge token. However,
external code shares the host JS context and can bypass the facade through the
same Tauri capabilities as the application. Do not describe the curated API as a
credential sandbox. External MCP tool registration is not part of this API-v1 scope.

## Verification

Before merging, run the normal project baseline:

```sh
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Record any host-runtime limitation that prevents Rust tests from executing.
Regression coverage should include the original UI render baselines, extension
manifest/registry behavior, enable/disable transitions, busy-operation rejection,
transfer cancellation, status parsers and cache lifetime, and default MCP tool
contracts. Do not update old UI snapshots merely to make a refactor pass.

Browser checks using simulated Tauri responses can compare the actual frontend
before and after migration without touching user servers. They do not replace
native desktop testing of SSH authentication, real uploads/downloads, or remote
command execution. Keep those validation levels separate in reports.

See also [SFTP Transfer Guide](../features/sftp_transfer.md),
[Server Status Guide](../features/server_status.md), and the
[RPC contract](../../specs/openapi.yaml).
