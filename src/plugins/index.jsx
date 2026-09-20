// The only place builtin plugins are registered. Import order mirrors the
// shared manifest (`extensions/builtin.json`): sftp (order 10) before
// server-monitor (order 20), so discovery order is deterministic.
import { createPluginHostBridge } from "../lib/plugin-host";
import { createPluginApi } from "./api";
import { getPluginHostContext, setPluginHostContext } from "./context";
import { registerPlugin } from "./registry";
import { createStatusPlugin } from "./status/index.jsx";
import { createSftpPlugin } from "./sftp/index.jsx";

let registered = false;

// One API per builtin plugin, created once at registration. Builtins are the
// facade's first consumer and regression baseline: they go through the same
// `createPluginApi` surface as external plugins, so a facade regression
// breaks the builtins first.
const builtinApi = (pluginId) =>
  createPluginApi(pluginId, {
    host: createPluginHostBridge(),
    getContext: () => getPluginHostContext(),
  });

/**
 * Registers every builtin plugin exactly once. Safe to call repeatedly (app
 * remounts, HMR): the second call is a no-op.
 */
export function registerBuiltinPlugins() {
  if (registered) {
    return;
  }
  registered = true;
  registerPlugin(createSftpPlugin(builtinApi("eshell.sftp")));
  registerPlugin(createStatusPlugin(builtinApi("eshell.server-monitor")));
}

export {
  registerPlugin,
  listPlugins,
  getPlugin,
  listPanelContributions,
  listToolbarContributions,
  listPluginControllers,
  subscribeRegistry,
  getRegistryVersion,
  notifyPluginChanged,
} from "./registry";
export { resolvePanelContributions, resolveToolbarContributions } from "./contributions";
export { getPluginHostContext, setPluginHostContext } from "./context";
export { useExtensionState, defaultExtensionState, normalizeExtensionList, normalizeExtensionRecord, mergeExtensionRecords, seedExtensionStateSnapshot } from "./extensions/extensionState";
export { DEFAULT_BUILTIN_EXTENSION_MANIFEST } from "./extensions/builtinManifest";
export { SFTP_PANEL_ID, SFTP_EXTENSION_ID, useSftpController } from "./sftp/index.jsx";
export { STATUS_PANEL_ID, STATUS_EXTENSION_ID, useStatusController } from "./status/index.jsx";
