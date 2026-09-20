// Central plugin registration. The workbench imports nothing concrete from
// the sftp / server-monitor plugins; each plugin registers its own
// controllers and panel factories here, and the workbench consumes whatever
// the registry holds in manifest (discovery) order.
//
// `src/plugins/index.js` is the only module that calls `registerPlugin`; it is
// imported once from the app root, so registration is deterministic: plugins
// register in manifest order (sftp, then status), and contributions are
// resolved against that order regardless of import timing.
//
// The external loader (`loader.js`) registers and unregisters whole plugin
// shapes at runtime (enable / disable). Every registration change bumps the
// registry version and notifies subscribers (`subscribeRegistry`), so generic
// UI consumers (`AppMainWorkspace`, `TopToolbar`) re-render when a late or
// removed registration changes what `contributions.js` would resolve —
// without touching contribution resolution itself.

const plugins = new Map();
// id -> the plugin object that currently owns the id. Owner-checked so a
// stale unregister (an old activation's late cleanup) can never delete a
// newer generation's registration under the same id.
const registered = new Map();

// Registry change notifications. The version is the `useSyncExternalStore`
// snapshot: a plain number that only changes when the registry actually
// changed, so consumers re-render once per change and never loop.
let registryVersion = 0;
const registryListeners = new Set();

const notifyRegistryChange = () => {
  registryVersion += 1;
  for (const listener of [...registryListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("[plugin-registry] registry listener failed", error);
    }
  }
};

export const registerPlugin = (plugin) => {
  if (!plugin || typeof plugin !== "object" || !plugin.id) {
    return () => {};
  }

  if (registered.has(plugin.id)) {
    // Double registration is a no-op (module re-evaluation under HMR), not an
    // error: silently keeping the first registration preserves order.
    return () => {};
  }

  registered.set(plugin.id, plugin);
  plugins.set(plugin.id, plugin);
  notifyRegistryChange();
  return () => {
    // Owner-safe unregister: only the registration that currently owns the
    // id removes it. A second dispose, or a losing activation's late cleanup
    // arriving after a newer generation registered the same id, is a no-op.
    if (registered.get(plugin.id) === plugin) {
      registered.delete(plugin.id);
    }
    if (plugins.get(plugin.id) === plugin) {
      plugins.delete(plugin.id);
    }
    notifyRegistryChange();
  };
};

export const listPlugins = () => [...plugins.values()];

export const getPlugin = (id) => plugins.get(id) || null;

/**
 * Subscribes to registry changes (registration, unregister, or an explicit
 * `notifyPluginChanged`). Returns an unsubscribe function.
 */
export const subscribeRegistry = (listener) => {
  if (typeof listener !== "function") {
    return () => {};
  }
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
};

/**
 * The registry version: a number that changes exactly once per registry
 * change. Suitable as a `useSyncExternalStore` snapshot.
 */
export const getRegistryVersion = () => registryVersion;

/**
 * Notifies consumers that a registered plugin's contributed content changed
 * without a register/unregister transition (for example a plugin that
 * re-staged its panels in place). Registration changes notify automatically;
 * this is for content-only changes.
 */
export const notifyPluginChanged = () => {
  notifyRegistryChange();
};

// Controllers, keyed by plugin id. The workbench composes these directly:
// `createWorkbenchPlugins()` walks `listPlugins()` in registration (manifest)
// order and calls each `createController` once.
export const listPluginControllers = () =>
  listPlugins()
    .map((plugin) =>
      typeof plugin.createController === "function" ? plugin : null,
    )
    .filter(Boolean);

// Panel contributions across all registered plugins, in registration order.
// The shared manifest decides discovery order (sftp before status); within one
// plugin, `panels` decides panel order.
export const listPanelContributions = () =>
  listPlugins().flatMap((plugin) => {
    const panels =
      typeof plugin.panels === "function"
        ? plugin.panels()
        : Array.isArray(plugin.panels)
          ? plugin.panels
          : [];
    return panels.map((panel) => ({ ...panel, pluginId: plugin.id }));
  });

// Toolbar contributions, same rules as panels.
export const listToolbarContributions = () =>
  listPlugins().flatMap((plugin) => {
    const toolbar =
      typeof plugin.toolbar === "function"
        ? plugin.toolbar()
        : Array.isArray(plugin.toolbar)
          ? plugin.toolbar
          : [];
    return toolbar.map((item) => ({ ...item, pluginId: plugin.id }));
  });
