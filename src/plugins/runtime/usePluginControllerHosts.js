// The keyed external controller hosts for the current registry.
//
// Returns one `<ExternalControllerHost key={activationKey} plugin={plugin} />`
// per *external* activation that contributes a controller. The caller renders
// them as siblings next to the core layout; enabling a plugin appends one
// keyed element and disabling removes exactly that element, so:
//   - no hook ever runs in a loop over plugins (each host runs its own
//     plugin's hook inside its own component);
//   - the core terminal's component chain never changes — it cannot remount
//     because a plugin was enabled or disabled.
//
// The key embeds the per-activation token (`controllerHostKey`): the same
// activation object keeps its component instance (controller state preserved
// across registry re-renders); a REPLACEMENT activation object under the same
// plugin id gets a new key and mounts fresh — a rapid off/on can never reuse
// the previous activation's controller state.
//
// Builtin plugins (sftp / status) are excluded here: their controllers keep
// their original direct call in `useWorkbench`, unchanged.
import { createElement } from "react";
import { listPlugins } from "../registry";
import { useRegistryVersion } from "./useRegistry";
import ExternalControllerHost, { controllerHostKey } from "./ExternalControllerHost";

/**
 * The controller host elements for every registered external plugin with a
 * controller. Stable per registry version; renders nothing for builtins.
 */
export function usePluginControllerHosts() {
  // Re-resolve when the registry changes: enable appends a host, disable
  // drops one (the dropped activation's store goes unreachable with it).
  useRegistryVersion();
  return listPlugins()
    .filter((plugin) => plugin.builtin === false && typeof plugin.createController === "function")
    .map((plugin) =>
      createElement(ExternalControllerHost, { key: controllerHostKey(plugin), plugin }),
    );
}
