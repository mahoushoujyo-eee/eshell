# External plugin implementation contract

This supplements `external-plugin-loading.md` with the concrete integration
contract. It is an implementation agreement, not a security boundary.

## Decisions

- Route A: trusted local ESM in the host JS context. No sandbox, marketplace,
  permission system, hot reload, or storage-root migration.
- API version 1 only. No PTY input API. External React controllers are allowed,
  but each runs in a separate keyed React component, never in a dynamic hook loop.
- `eshell.react` is the host React instance. Example plugins use
  `eshell.react.createElement` and relative ESM imports; no bare `react` import,
  bundled second React instance, or uncompiled JSX.
- Keep `contributions.js` sorting/filtering semantics. Generic consumers and
  registry change subscriptions are necessary to actually show external panels.
- Keep the current monitoring improvements: serialized polls, batched probes,
  and the 20-second native budget. Do not restore the earlier polling algorithm.
- Do not auto-commit or discard the existing working tree.
- Activation timeouts only bound asynchronous waiting; synchronous plugin loops
  can still freeze the application in this explicitly trusted execution model.

## Native transport

Existing Tauri commands and successful DTOs remain compatible. Add:

1. `list_external_plugins()` returns descriptor rows with existing metadata,
   `builtin: false`, `enabled`, `main`, and a platform-correct `bundleUrl`.
   Windows URL: `http://plugin.localhost/<encoded-id>/<main>`; other supported
   desktop platforms use the registered `plugin` scheme. Only discovered plugin
   directories are served. Do not expose the extension-state file.
2. `invoke_extension_api({ input: { extensionId, command, args } })` executes a
   whitelisted **existing command name/argument shape**, returning its existing
   successful DTO. `command` is private transport, not exposed on the plugin API.
   Hold the caller extension's native lease across the entire operation, in
   addition to any provider's existing lease. This is lifecycle accounting, not
   authentication: same-context code can still bypass the facade.

Whitelist the existing session list/open/close/execute, SFTP operations and status
fetch/cache needed by the facade. Do not include raw PTY input or configuration
credential APIs. Add private broker operations `select_upload_file` and
`select_download_dir` for native file selection, accepting optional `title` and
`defaultPath` as appropriate, returning a path string or null. Native picker
callbacks must retain the caller lease until they resolve.

`list_extensions` / `set_extension_enabled` / `extensions-changed` now use the
merged catalog. Enabling/disabling persists to `extensions/state.json`. A failed
write must reject the transition without publishing a successful state/event;
keep busy validation, persistence, flag update and cleanup ordered as one
transaction. Do not change the existing lease/activation concurrency invariant.

## Discovery and protocol

- Scan immediate child directories for `manifest.json`, sorted deterministically.
- Validate nonempty unique identity, required display name/version, API version 1,
  external `builtin:false`, default-enabled true, optional main `index.js`, optional
  contributes/panels. Built-in manifest validation remains strict and separate.
- A directory need not equal its manifest ID: resolve by the discovered catalog,
  never concatenate an untrusted ID into a filesystem path.
- Reject absolute/parent paths and canonical escapes, including symlinks. Validate
  both the entry module and every protocol asset request; accept only an explicit
  suffix/MIME allowlist. Missing, invalid or unknown resources return an HTTP error,
  never panic. Serve JS/MJS with a JavaScript MIME type and CORS headers.
- Invalid plugins are logged/skipped independently. `state.json` is not a plugin.
- The plan's referenced `src-tauri/src/ipc/protocol.rs` does not exist; register
  the protocol in the actual application Builder.

## Frontend facade

`src/plugins/api.js` exports `createPluginApi(pluginId, options?)`, returning the
public API. Host-only lifecycle helpers may be separate exports; do not put raw
transport on the returned API. `src/lib/plugin-host.js` is the private bridge to
`tauri-api.js`, native pickers and event transport. Append only the two native
command wrappers above to the existing `api` facade.

Public namespaces follow the plan:

- `sessions.list/open/close/execute/onOutput/onClosed/onHostKeyPrompt`
- `sftp.listDir/readFile/writeFile/createFile/createDirectory/deleteEntry/renameEntry`
- `sftp.uploadLocalFile/downloadToLocal/cancelTransfer/defaultDownloadDir`
- `sftp.selectUploadFile/selectDownloadDir/onTransfer`
- `status.fetch/cached`
- `ui.registerPanel/registerToolbar/registerController/getContext`
- `storage.get/set/remove`, `log.info/warn/error`, `meta.pluginId/apiVersion`, `react`

Preserve real parameter shapes, including `deleteEntry(sessionId,path,entryType)`
and the existing progress-transfer argument order. Storage is JSON under a
plugin-ID prefix. Existing built-in host preference keys remain compatibility
settings; do not silently rename them.

Event subscriptions return synchronous idempotent unsubscribe functions even if
native listener registration is asynchronous. They register only on explicit
subscription, unwrap/validate payloads, support an optional `{sessionId}` filter,
and are owned by the API activation scope. No generic `listen` or event envelope
is public. Terminal output is an explicit subscription, not an ambient feed.

There is no native host-key event. `onHostKeyPrompt` observes a host bridge signal
when the workbench presents a TOFU challenge (or an SDK open reports such a
challenge); it must not alias `ssh-ki-prompt`, expose password replies, auto-trust a
key, or add a trust-write API. The bridge exports `emitHostKeyPrompt(challenge)`
for the existing workbench prompt path; open failures still reject normally.

## Registration and UI contract

The loader stages activation registrations, then publishes the existing plugin
shape atomically:

```js
{
  id, builtin: false, api,
  createController, // optional hook, called inside its own component
  panels: () => panels,
  toolbar: () => toolbar
}
```

- Panels: `id`, optional `key` (defaults to id), `order`, `title`, `defaultVisible`,
  and `render(props)`. Validate globally unique panel keys/IDs including `draft`.
- Toolbar: `id`, optional `key`, `order`, `panelId`, `label`, `icon`, `onClick`.
  A `panelId` button toggles that panel; otherwise call the action. Unknown icons
  get a host fallback. Built-ins retain their existing icons and translated labels.
- `ui.registerController(hook)` permits one controller per plugin; it returns an
  unregister function just like other registrations.
- External render props: `{ api, context, controller }`, where `context` is the
  shared workbench snapshot and `controller` is that plugin's controller output.
  `ui.getContext()` returns that same current snapshot (empty before workbench
  mount). Context contains sessions, activeSessionId, activeSession and panel
  show/hide/toggle helpers; it is a contract, not privileged access isolation.
- UI owner supplies `src/plugins/context.js` (`getPluginHostContext`,
  `setPluginHostContext`) and keyed controller hosts. Do not introduce hooks whose
  order changes when a plugin is enabled or disabled.
- Registry keeps its existing exports and adds `subscribeRegistry(listener)`,
  `getRegistryVersion()`, `notifyPluginChanged()` so late registrations/removals
  rerender consumers without changing contribution resolution.
- Keep old 0/1/2/3 panel layouts and KeepAlive identities; support additional panels
  without blanking the entire dock. Slot maps are instance-owned, not global DOM.
- Runtime panel/controller errors are contained at the external plugin boundary.

## Loader lifecycle

Before the first React render: register built-ins, subscribe to lifecycle changes,
load merged descriptors and external catalog, activate enabled externals, then
render. Seed the frontend extension state from that initial catalog so persisted
builtin deactivation does not briefly flash enabled UI.

Accept `export function activate(api)` or `export default function(api)`. Its
optional returned function is the activation's disposer. Use dynamic
`import(/* @vite-ignore */ bundleUrl)`, relative module URLs and the host React
instance. On disable: run disposer, dispose API-owned subscriptions/resources,
then unregister contributions. On re-enable: activate again (ESM module cache is
expected; source changes still require restart).

Handle activation exceptions, async timeouts, late completions, rapid off/on and
registration conflicts without leaking contributions/listeners or rolling back a
newer activation. A failed plugin must not block unrelated plugins or app startup.
The UI stage owns no plugin installer or new management screen; directory copying
and the existing lifecycle RPC/state file are the installation/control workflow.
