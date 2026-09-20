// Kubernetes panel for eShell — activation and host wiring.
//
// Scope: this plugin drives the `kubectl` CLI on the ACTIVE SSH SESSION through
// `eshell.sessions.execute`. The plugin facade has no local process access and
// no HTTP client for the API server, so this is a view of whatever cluster the
// connected host's kubeconfig points at — a bastion, a control-plane node, a
// laptop you SSH into. Nothing runs against a local kubeconfig.
//
// What it covers: any resource type `kubectl get` knows (tabs for the common
// ones, a box for everything else including CRDs), context and namespace
// switching per command, logs with a container picker, non-interactive exec,
// describe / -o yaml / events / explain, scale, rollout restart / status /
// history / undo, CronJob suspend and manual runs, node cordon / uncordon /
// drain, `kubectl top`, api-resources, cluster-info, bulk delete, and
// `kubectl apply -f -` from a text box with a server-side dry run.
//
// What it cannot do, by construction: attach to a TTY (`exec -it`), stream
// (`logs -f`, `get -w`), or hold a connection open (`port-forward` — the panel
// builds that command and hands it to the user instead). An exec channel runs
// one command and returns its output; the panel polls where the CLI streams.
//
// Layout — every file is small and single-purpose:
//   kubectl.js     the barrel over cli/ + parse/ + failures.js + client.js
//   cli/           command builders (get, workloads, session) + validation
//   parse/         the `-o wide` table reader and what a cell's text means
//   kinds.js       the resource types offered, and the verbs each supports
//   controller/    view state (prefs, listings, derivations, overlays)
//   panel/         the render tree (header, toolbar, table, actions, sheets)
//   ui/            presentational primitives over the host React
//   i18n.js        en / zh-CN strings, following `<html lang>`

import { createKubectlController } from "./controller/index.js";
import { createKubectlPanel } from "./panel/index.js";
import { createUi } from "./ui/index.js";
import { createUseLocale, t } from "./i18n.js";

const PANEL_ID = "com.example.kubernetes.panel";
const TOOLBAR_ID = "com.example.kubernetes.toolbar";
const TITLE = "Kubernetes";

export async function activate(eshell) {
  const react = eshell.react;
  const ui = createUi(react);
  const useLocale = createUseLocale(react);
  const useKubectlController = createKubectlController(react, { useLocale });
  const renderPanel = createKubectlPanel({ react, ui, t });

  // One controller for the activation; the panel is a pure render of its
  // snapshot. Registered here, in activate, never swapped afterwards — the
  // host's hook order must not change while the plugin is enabled.
  const disposeController = eshell.ui.registerController(useKubectlController);

  const disposePanel = eshell.ui.registerPanel({
    id: PANEL_ID,
    key: PANEL_ID,
    title: TITLE,
    order: 41,
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
    order: 41,
  });

  eshell.log.info("kubernetes panel activated");

  return () => {
    disposeToolbar();
    disposePanel();
    disposeController();
    eshell.log.info("kubernetes panel deactivated");
  };
}
