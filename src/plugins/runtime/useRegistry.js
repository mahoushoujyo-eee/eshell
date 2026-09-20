// Registry subscription hook for generic UI consumers.
//
// `useRegistryVersion()` re-renders its caller exactly once per registry
// change (registration, unregister, `notifyPluginChanged`): the snapshot is
// the registry version number, so `AppMainWorkspace` and `TopToolbar`
// re-resolve contributions whenever a late external registration or a
// disable lands — including after the first React render, which the
// pre-subscription code could not see.
import { useSyncExternalStore } from "react";
import { getRegistryVersion, subscribeRegistry } from "../registry";

const getServerSnapshot = () => getRegistryVersion();

/**
 * Subscribes the caller to registry changes. Returns the current registry
 * version (a number that changes once per change).
 */
export function useRegistryVersion() {
  return useSyncExternalStore(subscribeRegistry, getRegistryVersion, getServerSnapshot);
}
