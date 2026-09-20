// External panel host: renders one external plugin's panel.
//
// Props contract (see `docs/plans/external-plugin-contract.md`):
//   render({ api, context, controller })
//     api        the plugin's facade object (published by the loader)
//     context    the shared workbench snapshot (`getPluginHostContext()`)
//     controller that plugin's controller output (its controller store)
//
// The panel subscribes to its own plugin's controller store through a cached
// `useSyncExternalStore` snapshot (`usePluginController`), so controller
// state updates re-render exactly this panel. The controller may not have
// published its first output yet (the keyed host publishes in
// `useLayoutEffect`): until then the panel renders an empty container and
// waits one layout commit — it never calls `render` with an undefined
// controller.
//
// Render errors are contained here: a panel that throws renders the error
// placeholder below, not the whole dock.
import { useSyncExternalStore } from "react";
import { getPluginHostContext } from "../context";
import { getOrCreateControllerStore } from "./controllerStore";
import PluginRuntimeErrorBoundary from "./PluginRuntimeErrorBoundary";
import { useI18n } from "../../lib/i18n";

const EMPTY_SNAPSHOT = { pluginId: null, version: 0, ready: true, controller: Object.freeze({}) };
const noopSubscribe = () => () => {};
const getEmptySnapshot = () => EMPTY_SNAPSHOT;

/**
 * Subscribes to one activation's controller store. The store is keyed by the
 * activation object (`plugin`), so a replaced activation (rapid off/on)
 * publishes a fresh store the panel re-subscribes to, and a stale cleanup
 * holding the old object cannot touch it. The store's `getSnapshot` is cached
 * per change, so this never loops.
 */
export function usePluginController(plugin) {
  // The store's methods close over the store's own state (never `this`), so
  // the references below are stable per store identity: no re-subscription on
  // unrelated renders. A getOrCreate in render is safe: it allocates plugin
  // host state, it does not read or mutate React-owned state. A plugin
  // without a controller is ready immediately; no host will publish a store
  // for it, so waiting for one would leave a valid simple panel blank forever.
  const store = typeof plugin?.createController === "function"
    ? getOrCreateControllerStore(plugin)
    : null;
  const subscribe = store ? store.subscribe : noopSubscribe;
  const getSnapshot = store ? store.getSnapshot : getEmptySnapshot;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Renders one external panel body. The panel's `render` is called only when
 * its controller snapshot is ready; until then an empty container holds the
 * layout slot so the dock does not flash.
 */
function ExternalPanelBody({ panel, plugin }) {
  const snapshot = usePluginController(plugin);
  if (!snapshot.ready) {
    // Controller not published yet (first layout commit pending). Holding an
    // empty container here is deliberate: calling render with an undefined
    // controller would throw inside plugin code.
    return <div className="h-full w-full" data-plugin-panel={panel.id} />;
  }
  return (
    panel.render({
      api: plugin.api,
      context: getPluginHostContext(),
      controller: snapshot.controller,
    }) ?? null
  );
}

/**
 * The host for one external panel: error-isolated, controller-gated.
 * `plugin` is the activation object the loader published (`.api` is the
 * facade; the controller store is keyed by this object).
 */
export default function ExternalPanelHost({ panel, plugin }) {
  const { t } = useI18n();
  return (
    <PluginRuntimeErrorBoundary
      label={`panel ${panel.id}`}
      render={
        <div className="h-full w-full p-4 text-xs text-muted" data-plugin-panel-error={panel.id}>
          {panel.title || panel.id}: {t("Panel failed to render")}
        </div>
      }
    >
      <ExternalPanelBody panel={panel} plugin={plugin} />
    </PluginRuntimeErrorBoundary>
  );
}
