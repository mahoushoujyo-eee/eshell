// Plugin host context: the shared workbench snapshot handed to plugins.
//
// Contract (see `docs/plans/external-plugin-contract.md`):
// - `ui.getContext()` returns this same current snapshot (empty before
//   workbench mount). It contains sessions, activeSessionId, activeSession
//   and the panel show/hide/toggle helpers.
// - External render props are `{ api, context, controller }`: `context` is
//   this snapshot, `controller` that plugin's controller output.
// - It is a contract, not privileged access isolation.
//
// The workbench mount (UI owner) calls `setPluginHostContext(snapshot)` on
// every render; `getPluginHostContext()` is what `ui.getContext()` and the
// keyed controller hosts read. Nothing here changes hook order when a plugin
// is enabled or disabled: the snapshot is a plain object, and controller
// hosts are keyed per plugin id.

let currentContext = {};

/**
 * Installs the current workbench snapshot. The workbench calls this with a
 * fresh snapshot object on every render; identity changes are expected and
 * cheap (plugins read through `getContext()`, they do not subscribe).
 */
export const setPluginHostContext = (snapshot) => {
  currentContext =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot
      : {};
};

/**
 * The current workbench snapshot (empty object before workbench mount).
 */
export const getPluginHostContext = () => currentContext;
