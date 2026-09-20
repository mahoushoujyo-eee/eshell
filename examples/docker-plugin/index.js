// Docker panel for eShell — activation and host wiring.
//
// Scope: this plugin drives the `docker` CLI on the ACTIVE SSH SESSION through
// `eshell.sessions.execute`. The plugin facade has no local process or socket
// access, so this is a remote-host Docker client, not a Docker Desktop
// replacement — it talks to whatever daemon the connected host exposes, over
// the session's existing SSH transport.
//
// What it covers: containers (run / lifecycle / logs / exec / inspect / top /
// diff / port / rename / bulk actions / live stats), images (pull / push / tag
// / history / inspect / remove / prune / Hub search), volumes, networks,
// Compose projects, `docker events`, and a System tab over `docker info`,
// `docker version` and `docker system df` with every `prune` variant.
//
// What it cannot do, by construction: attach to a TTY (`docker exec -it`,
// `docker attach`), stream (`logs -f`, unbounded `events`, `stats` without
// `--no-stream`), or build an image from a local context. An exec channel runs
// one command and returns its output; the panel polls where the CLI streams.
//
// Layout — every file is small and single-purpose; each directory has a short
// note at the top of its entry module:
//   docker.js      the barrel over cli/ + parse/ + failures.js + client.js
//   cli/           command builders, one file per docker object family
//   parse/         output readers
//   controller/    view state (prefs, listings, derivations, overlays)
//   panel/         the render tree (rows, toolbar, tabs, sheets, modals)
//   ui/            presentational primitives over the host React
//   i18n.js        en / zh-CN strings, following `<html lang>`

import { createDockerController } from "./controller/index.js";
import { createDockerPanel } from "./panel/index.js";
import { createUi } from "./ui/index.js";
import { createUseLocale, t } from "./i18n.js";

const PANEL_ID = "com.example.docker.panel";
const TOOLBAR_ID = "com.example.docker.toolbar";
const TITLE = "Docker";

export async function activate(eshell) {
  const react = eshell.react;
  const ui = createUi(react);
  const useLocale = createUseLocale(react);
  const useDockerController = createDockerController(react, { useLocale });
  const renderPanel = createDockerPanel({ react, ui, t });

  // One controller for the activation; the panel is a pure render of its
  // snapshot. Registered here, in activate, never swapped afterwards — the
  // host's hook order must not change while the plugin is enabled.
  const disposeController = eshell.ui.registerController(useDockerController);

  const disposePanel = eshell.ui.registerPanel({
    id: PANEL_ID,
    key: PANEL_ID,
    title: TITLE,
    order: 40,
    // Left at the default (hidden): panel visibility is not persisted, so a
    // panel that opened itself would re-open on every launch.
    render: renderPanel,
  });

  const disposeToolbar = eshell.ui.registerToolbar({
    id: TOOLBAR_ID,
    key: TOOLBAR_ID,
    panelId: PANEL_ID,
    label: TITLE,
    // `import.meta.url` is this module's own `plugin://` URL, so the icon
    // ships next to the code and needs no host-side registration.
    icon: new URL("./icon.svg", import.meta.url).href,
    order: 40,
  });

  eshell.log.info("docker panel activated");

  return () => {
    disposeToolbar();
    disposePanel();
    disposeController();
    eshell.log.info("docker panel deactivated");
  };
}
