// Per-activation controller store: the sibling store behind the keyed
// controller hosts (`ExternalControllerHost`).
//
// Contract (see `docs/plans/external-plugin-contract.md` and the runtime
// notes in `usePluginControllerHosts`):
// - Exactly one controller instance per activation, running inside its own
//   keyed React component; the workbench never loops hooks over plugins.
// - The store is keyed by the ACTIVATION OBJECT, not the plugin id.
//   Re-enabling publishes a new activation object, which gets a fresh store
//   and a fresh controller instance. A stale cleanup holding the old object
//   cannot touch the new store: `removeControllerStore(oldPlugin)` only ever
//   deletes the WeakMap entry keyed by that exact object.
// - The store is NOT removed by the host's effect cleanup. React StrictMode
//   simulates an unmount+remount of effects while the component stays
//   mounted; removing the store there would strand the still-mounted runner
//   (publishing into an orphan) and the panel (subscribed to a replacement)
//   on two different stores — the panel would stay not-ready forever. The
//   store lives as long as its activation object is reachable: the registry
//   drops the object on unregister, the hosts array stops rendering it, and
//   the WeakMap entry follows the object to GC.
// - `getSnapshot()` is cached per change, so a `useSyncExternalStore` panel
//   re-renders exactly once per real change and never in a loop.
// - Publishing controller state never calls back into the controller: the
//   store notifies its listeners, nothing more.

const stores = new WeakMap();
const activationTokens = new WeakMap();
let nextActivationToken = 1;

/**
 * A stable per-activation token for React element keys: the same activation
 * object keeps its token (and therefore its component instance) across
 * registry re-renders; a replaced activation gets a new token and remounts
 * fresh instead of reusing the previous activation's hook state.
 */
export const getActivationToken = (plugin) => {
  if (!plugin || typeof plugin !== "object") {
    return 0;
  }
  let token = activationTokens.get(plugin);
  if (token === undefined) {
    token = nextActivationToken;
    nextActivationToken += 1;
    activationTokens.set(plugin, token);
  }
  return token;
};

const createControllerStore = (plugin) => {
  const pluginId = String(plugin.id ?? "");
  // Published before the controller's first render commits: the panel renders
  // an empty waiting container instead of receiving an undefined controller.
  let ready = false;
  let controller = null;
  let version = 0;
  let cachedSnapshot = null;
  const listeners = new Set();

  const buildSnapshot = () => {
    cachedSnapshot = { pluginId, version, ready, controller };
    return cachedSnapshot;
  };

  return {
    pluginId,
    /** Publishes one controller output (the hook's return value). */
    publish(nextController) {
      if (ready && nextController === controller) {
        // Same object: no change, no notification. A controller that returns
        // a brand-new object every render still publishes per real change.
        return;
      }
      ready = true;
      controller = nextController;
      version += 1;
      buildSnapshot();
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn(`[controller-store ${pluginId}] listener failed`, error);
        }
      }
    },
    /** The cached snapshot for `useSyncExternalStore`. Stable per change. */
    getSnapshot() {
      return cachedSnapshot === null ? buildSnapshot() : cachedSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** True once the first controller output was published. */
    isReady: () => ready,
  };
};

/**
 * The controller store for one activation, created on first request.
 * `getOrCreateControllerStore(plugin)` is idempotent per activation object.
 */
export const getOrCreateControllerStore = (plugin) => {
  if (!plugin || typeof plugin !== "object" || !plugin.id) {
    return null;
  }
  let store = stores.get(plugin);
  if (!store) {
    store = createControllerStore(plugin);
    stores.set(plugin, store);
  }
  return store;
};

/** The existing store for one activation, without creating one. */
export const getControllerStore = (plugin) =>
  plugin && typeof plugin === "object" ? stores.get(plugin) || null : null;

/**
 * Explicit owner-checked teardown: deletes only the entry keyed by THIS
 * activation object. A stale cleanup (an old activation's late teardown)
 * can never remove a newer activation's store, because the WeakMap key is
 * the activation object itself. The controller host does not call this on
 * effect cleanup (see the StrictMode note above); it exists for explicit
 * teardown paths and tests.
 */
export const removeControllerStore = (plugin) => {
  if (plugin && typeof plugin === "object") {
    stores.delete(plugin);
  }
};
