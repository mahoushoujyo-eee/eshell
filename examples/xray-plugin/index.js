// Xray proxy panel for eShell — activation and host wiring.
//
// Scope: this plugin drives the `xray` binary on the ACTIVE SSH SESSION
// through `eshell.sessions.execute`. The plugin facade has no local process
// access and no HTTP client, so this is a view of the xray installation on
// the connected host — the box you ssh into, the one that terminates the
// traffic. Nothing runs against a local xray.
//
// What it covers: finding the binary, the config and the service; the
// balancers (the groups) that pick between outbounds; the subscriptions that
// fill the config with nodes; and selecting the node a group uses.
//
// What it cannot do, by construction: keep a subscription on a schedule
// (there is no timer that survives the panel being closed), read a Clash
// YAML subscription, or change a node without restarting xray — the panel
// edits the config and lets xray restart, so the choice survives a reboot
// instead of living only in the running process.
//
// Layout — every file is small and single-purpose:
//   xray.js         the barrel over cli/ + parse/ + failures.js + client.js
//   cli/            command builders (detect, config, subscription) + validation
//   parse/          the config model, the share-link readers, the log reader
//   client.js       the async data layer, including the safe write path
//   controller/     view state (prefs, derivations, overlays)
//   panel/          the render tree (header, overview, groups, nodes, sheets)
//   ui/             presentational primitives over the host React
//   i18n.js         en / zh-CN strings, following `<html lang>`

import { createXrayController } from "./controller/index.js";
import { createXrayPanel } from "./panel/index.js";
import { createUi } from "./ui/index.js";
import { createUseLocale, t } from "./i18n.js";

const PANEL_ID = "com.example.xray.panel";
const TOOLBAR_ID = "com.example.xray.toolbar";
const TITLE = "Xray Proxy";

export async function activate(eshell) {
  const react = eshell.react;
  const ui = createUi(react);
  const useLocale = createUseLocale(react);
  const useXrayController = createXrayController(react, { useLocale, t });
  const renderPanel = createXrayPanel({ react, ui, t });

  // One controller for the activation; the panel is a pure render of its
  // snapshot. Registered here, in activate, never swapped afterwards — the
  // host's hook order must not change while the plugin is enabled.
  const disposeController = eshell.ui.registerController(useXrayController);

  const disposePanel = eshell.ui.registerPanel({
    id: PANEL_ID,
    key: PANEL_ID,
    title: TITLE,
    order: 42,
    // Left at the default (hidden): panel visibility is not persisted, so a
    // panel that opened itself would re-open on every launch.
    render: renderPanel,
  });

  const disposeToolbar = eshell.ui.registerToolbar({
    id: TOOLBAR_ID,
    key: TOOLBAR_ID,
    panelId: PANEL_ID,
    label: TITLE,
    // `import.meta.url` is this module's own `plugin://` URL, so the icon ships
    // next to the code and needs no host-side registration.
    icon: new URL("./icon.svg", import.meta.url).href,
    order: 42,
  });

  eshell.log.info("xray panel activated");

  return () => {
    disposeToolbar();
    disposePanel();
    disposeController();
    eshell.log.info("xray panel deactivated");
  };
}
