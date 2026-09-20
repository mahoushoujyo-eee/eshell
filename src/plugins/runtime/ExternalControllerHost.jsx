// Keyed external controller host.
//
// One `<ExternalControllerHost key={activationKey} plugin={plugin} />` per
// external activation, rendered as a sibling (it renders nothing itself).
// The core terminal's hook chain never changes when a plugin is enabled or
// disabled: enabling mounts one more keyed host, disabling removes exactly
// that host, and every other host (and the terminal) keeps its identity.
//
// Ownership model (see `controllerStore`):
// - The store is keyed by the ACTIVATION OBJECT (`plugin`), not the plugin
//   id. `key` embeds the per-activation token, so a rapid off/on that
//   publishes a replacement object remounts a fresh host with a fresh
//   controller instance instead of reusing the previous activation's hook
//   state under the same key.
// - The host does NOT remove the store in its effect cleanup. React
//   StrictMode simulates an unmount/remount of effects while the component
//   stays mounted; deleting the store there would split the still-mounted
//   runner (publishing into an orphan) from the panel (subscribed to a
//   replacement) onto two different stores, and the panel would stay
//   not-ready forever. The store is unreachable (GC-able) once the registry
//   drops this activation object and nothing renders it.
//
// Render errors are contained at this boundary: a controller that throws
// renders the error boundary's fallback (null here), never the whole app.
// The builtin controllers are not affected — they keep their original direct
// call in `useWorkbench`.
import { useLayoutEffect } from "react";
import { getPluginHostContext } from "../context";
import { getActivationToken, getOrCreateControllerStore } from "./controllerStore";
import PluginRuntimeErrorBoundary from "./PluginRuntimeErrorBoundary";

/**
 * The stable React key for one activation: the plugin id plus the
 * per-activation token. Same activation object -> same key (same component
 * instance, controller state preserved across registry re-renders);
 * replacement activation object -> new key (fresh mount, no stale state).
 */
export const controllerHostKey = (plugin) =>
  `${String(plugin?.id ?? "plugin")}#${getActivationToken(plugin)}`;

/**
 * Runs one external plugin's controller hook and publishes its output.
 * Rendered inside the error boundary below; keyed per activation by the
 * parent. The runner resolves its store lazily on every render so a store
 * created by a later mount (or re-associated by StrictMode's simulated
 * remount) is picked up without stranding an earlier closure.
 */
function ExternalControllerRunner({ plugin }) {
  const createController = plugin.createController;

  // The controller output. The hook call is unconditional (same hook order
  // every render of THIS component); the flat context spread is the contract:
  // `createController({ ...context, api })`.
  const controller = createController({
    ...getPluginHostContext(),
    api: plugin.api,
  });

  // Publish after layout, into the store keyed by this activation object.
  // The runner never removes a store (see the ownership notes above).
  useLayoutEffect(() => {
    getOrCreateControllerStore(plugin)?.publish(controller);
  });

  return null;
}

/**
 * The keyed host for one external activation. Renders null; mounts and
 * unmounts with the activation's registry lifecycle.
 */
export default function ExternalControllerHost({ plugin }) {
  if (!plugin || typeof plugin.createController !== "function") {
    return null;
  }
  return (
    <PluginRuntimeErrorBoundary label={`controller ${plugin.id}`} render={null}>
      <ExternalControllerRunner plugin={plugin} />
    </PluginRuntimeErrorBoundary>
  );
}
