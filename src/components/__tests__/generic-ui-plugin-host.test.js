/**
 * Generic UI consumer tests: a real third and fourth panel (arbitrary ids,
 * not sftp/status), a toolbar action, visibility/controller hooks, and
 * disabled-plugin teardown — through the real registry, the real
 * AppMainWorkspace/TopToolbar, and the real useWorkbench composition.
 *
 * These are NOT shape tests and do NOT mock the workbench: the failures this
 * suite exists to catch (a dropped unknown key blanking the dock, a slot map
 * shared across instances, a controller published during render) all hide
 * behind mocks.
 *
 * The dock mirrors the real AppWorkspace structure: AppMainWorkspace renders
 * the panels, the controller hosts render as siblings next to it — the
 * external panel body deliberately waits for its controller's first
 * published snapshot instead of rendering with an undefined controller.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    const handler = commandHandlers.get(command);
    if (!handler) {
      throw new Error(`unmocked command in test: ${command}`);
    }
    return handler(args ?? {});
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, handler) => {
    if (!eventListeners.has(name)) {
      eventListeners.set(name, new Set());
    }
    eventListeners.get(name).add(handler);
    return () => eventListeners.get(name)?.delete(handler);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeXterm {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    paste() {}
    write() {}
    focus() {}
    getSelection() {
      return "";
    }
    clearSelection() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const commandHandlers = new Map();
const eventListeners = new Map();

import { act } from "react";
import { createElement, Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  findElement,
  findElements,
  installFakeDom,
  uninstallFakeDom,
} from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";
import { makeAcp, makeUi, makeWorkbench } from "../../test/workbench-fixtures.js";
import { registerBuiltinPlugins } from "../../plugins/index.jsx";
import { setPluginHostContext } from "../../plugins/context.js";
import {
  getPlugin,
  registerPlugin,
  getRegistryVersion,
  subscribeRegistry,
} from "../../plugins/registry.js";
import AppMainWorkspace from "../app/AppMainWorkspace.jsx";
import TopToolbar from "../layout/TopToolbar.jsx";
import { useWorkbench } from "../../hooks/useWorkbench.js";
import { I18nProvider } from "../../lib/i18n";
import { getControllerStore, removeControllerStore } from "../../plugins/runtime/controllerStore.js";
import ExternalControllerHost, {
  controllerHostKey,
} from "../../plugins/runtime/ExternalControllerHost.jsx";

registerBuiltinPlugins();

// ---------------------------------------------------------------------------
// A real external-plugin fixture: arbitrary ids ("com.example.third" /
// "com.example.fourth"), a controller with state, a panel reading
// { api, context, controller }, a toolbar item.
// ---------------------------------------------------------------------------
const EXTERNAL_EXTENSIONS = [
  {
    id: "eshell.sftp",
    displayName: "SFTP",
    version: "1.0.0",
    apiVersion: 1,
    builtin: true,
    enabled: true,
    contributes: { panels: [{ id: "sftp", order: 10 }] },
  },
  {
    id: "eshell.server-monitor",
    displayName: "Server Monitor",
    version: "1.0.0",
    apiVersion: 1,
    builtin: true,
    enabled: true,
    contributes: { panels: [{ id: "status", order: 20 }] },
  },
  {
    id: "com.example.third",
    displayName: "Third",
    version: "1.0.0",
    apiVersion: 1,
    builtin: false,
    enabled: true,
    contributes: { panels: [{ id: "third.panel", order: 30 }] },
  },
  {
    id: "com.example.fourth",
    displayName: "Fourth",
    version: "1.0.0",
    apiVersion: 1,
    builtin: false,
    enabled: true,
    contributes: { panels: [{ id: "fourth.panel", order: 40 }] },
  },
];

const THIRD_PANEL_KEY = "third.panel";
const FOURTH_PANEL_KEY = "fourth.panel";

/** A controller hook fixture: a click counter, exactly like a real plugin. */
const makeExternalController = (id) => (ctx) => {
  // The controller must receive the flat context spread plus `api`.
  if (!ctx || typeof ctx !== "object" || !("api" in ctx)) {
    throw new Error(`${id} controller did not receive { ...context, api }`);
  }
  return {
    clicks: 0,
    increment: () => {},
    api: ctx.api,
    sessionId: ctx.activeSessionId ?? null,
  };
};

const registerExternalPlugin = (id, overrides = {}) => {
  const api = { meta: { pluginId: id, apiVersion: 1 } };
  const panelKey = overrides.panelKey ?? `${id.split(".").pop()}.panel`;
  const title = overrides.title ?? id;
  // The base render. `overrides.wrapPanelRender` wraps it IN PLACE (the same
  // activation object keeps rendering through the wrapper): building a
  // second plugin object here would split the controller store the panel
  // subscribes to from the one the host publishes into.
  const baseRender = ({ api: panelApi, context, controller }) =>
    createElement(
      "section",
      { className: "h-full w-full bg-panel p-3 text-xs", "data-panel": panelKey },
      createElement("h3", { className: "text-sm font-semibold" }, title),
      createElement(
        "p",
        { "data-panel-api": panelKey },
        `api:${panelApi?.meta?.pluginId ?? "none"}`,
      ),
      createElement(
        "p",
        { "data-panel-session": panelKey },
        `session:${context?.activeSessionId ?? "none"}`,
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-panel-counter": panelKey,
          onClick: () => controller?.increment?.(),
        },
        `clicks:${controller?.clicks ?? "?"}`,
      ),
    );
  // Optional instrumentation: every controller value the wrapped render
  // received (only populated when wrapPanelRender is used).
  const seenControllers = [];
  const originalPanel = {
    id: panelKey,
    key: panelKey,
    order: overrides.order ?? 30,
    defaultVisible: overrides.defaultVisible,
    title,
    render: overrides.wrapPanelRender
      ? (props) => {
        seenControllers.push(props.controller ?? null);
        return overrides.wrapPanelRender(props, baseRender);
      }
      : baseRender,
  };
  const controllerHook = overrides.controller ?? makeExternalController(id);
  const plugin = {
    id,
    builtin: false,
    api,
    createController: controllerHook,
    panels: () => [{ ...originalPanel }],
    toolbar: () => [
      {
        id: `${panelKey}.toolbar`,
        key: `${panelKey}.toolbar`,
        order: overrides.order ?? 30,
        panelId: panelKey,
        label: overrides.label ?? `${id} panel`,
        icon: "puzzle",
      },
    ],
  };
  const unregister = registerPlugin(plugin);
  return { unregister, plugin, panelKey, api, originalPanel, seenControllers };
};

describe("generic UI: third and fourth panels through the real workspace", () => {
  it("renders four visible panels without blanking the dock", async () => {
    installFakeDom();
    let cleanups = [];
    let mounted = null;
    try {
      const third = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
        order: 30,
        title: "Third Panel",
      });
      const fourth = registerExternalPlugin("com.example.fourth", {
        panelKey: FOURTH_PANEL_KEY,
        order: 40,
        title: "Fourth Panel",
      });
      cleanups = [third.unregister, fourth.unregister];

      // The workbench publishes the host context every render; this test
      // renders the dock without a live useWorkbench, so publish the same
      // minimal snapshot first (the real AppWorkspace always has it).
      setPluginHostContext({
        sessions: [],
        activeSessionId: "session-alpha",
        activeSession: null,
        disconnectedSessions: {},
      });

      // The controller hosts, rendered as siblings (AppWorkspace structure).
      const hosts = [
        createElement(ExternalControllerHost, { key: controllerHostKey(third.plugin), plugin: third.plugin }),
        createElement(ExternalControllerHost, { key: controllerHostKey(fourth.plugin), plugin: fourth.plugin }),
      ];
      mounted = await render(
        createElement(
          Fragment,
      null,
      createElement(AppMainWorkspace, {
        workbench: makeWorkbench({
          extensions: EXTERNAL_EXTENSIONS,
          panelVisibility: {
            sftp: true,
            status: true,
            [THIRD_PANEL_KEY]: true,
            [FOURTH_PANEL_KEY]: true,
          },
        }),
        acp: makeAcp(),
        showSftpPanel: true,
        showStatusPanel: true,
        showCommandDraftPanel: false,
        onOpenFileEditor: makeUi().onOpenFileEditor,
      }),
      ...hosts,
        ),
      );

      // The external panels waited for their controllers; flush the layout
      // effects so the published snapshots re-render the panel bodies.
      await act(async () => {});

      // All four panels are inside the layout (none stashed, none lost).
      expect(mounted.container.textContent).toContain("SFTP Browser");
      expect(mounted.container.textContent).toContain("Server Status");
      expect(mounted.container.textContent).toContain("Third Panel");
      expect(mounted.container.textContent).toContain("Fourth Panel");

      // External panels received { api, context, controller }: the panel body
      // shows the plugin's api id and the active session from the context.
      expect(mounted.container.textContent).toContain(`api:com.example.third`);
      expect(mounted.container.textContent).toContain("session:session-alpha");

      // 4+ panels nest: at least 4 bottom-area splitters, in order.
      const columnButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize columns",
      );
      expect(columnButtons.length).toBeGreaterThanOrEqual(4);

      // Order: sftp before status before third before fourth. Hosts are
      // located by their unique panel markers (data-panel on external
      // bodies, the panel headings for builtins), then compared by document
      // order.
      const orderIndexOf = (target) => {
        let index = 0;
        let found = -1;
        const walk = (node) => {
          if (found >= 0) return;
          if (node === target) {
            found = index;
            return;
          }
          index += 1;
          (node.childNodes || []).forEach(walk);
        };
        walk(mounted.container);
        return found;
      };
      const hostByKey = (key) =>
        findElement(mounted.container, (node) => node.getAttribute?.("data-panel") === key);
      const sftpHost = findElement(
        mounted.container,
        (node) => node.textContent.includes("SFTP Browser") && node.className?.includes("bg-panel"),
      );
      const statusHost = findElement(
        mounted.container,
        (node) => node.textContent.includes("Server Status") && node.className?.includes("bg-panel"),
      );
      const thirdHost = hostByKey(THIRD_PANEL_KEY);
      const fourthHost = hostByKey(FOURTH_PANEL_KEY);
      expect(thirdHost).not.toBeNull();
      expect(fourthHost).not.toBeNull();
      expect(orderIndexOf(sftpHost)).toBeLessThan(orderIndexOf(statusHost));
      expect(orderIndexOf(statusHost)).toBeLessThan(orderIndexOf(thirdHost));
      expect(orderIndexOf(thirdHost)).toBeLessThan(orderIndexOf(fourthHost));

      // Unregister (disable) FIRST, flush, then unmount: the scheduler must
      // not run registry notifications after the fake DOM is gone.
      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      await mounted.unmount();
    } finally {
      cleanups.forEach((fn) => fn());
      uninstallFakeDom();
    }
  });

  it("keeps unknown builtin keys from blanking the dock (skipped, not thrown)", async () => {
    installFakeDom();
    try {
      const workbench = makeWorkbench({
        extensions: EXTERNAL_EXTENSIONS.map((extension) =>
          extension.id === "eshell.sftp"
            ? {
                ...extension,
                contributes: { panels: [{ id: "sftp", order: 10 }, { id: "unknown-extra", order: 15 }] },
              }
            : extension,
        ),
      });
      const mounted = await render(
        createElement(AppMainWorkspace, {
          workbench,
          acp: makeAcp(),
          showSftpPanel: true,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );
      // The known panels still render; the unknown key is dropped, not fatal.
      expect(mounted.container.textContent).toContain("SFTP Browser");
      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });

  it("slot maps are instance-owned: two workspaces never share DOM", async () => {
    installFakeDom();
    try {
      const first = await render(
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(),
          acp: makeAcp(),
          showSftpPanel: true,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );
      const second = await render(
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(),
          acp: makeAcp(),
          showSftpPanel: true,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );

      const slots = (root) =>
        findElements(root, (node) => node.className === "h-full w-full");
      const firstSlots = slots(first.container);
      const secondSlots = slots(second.container);
      // Distinct DOM nodes per instance.
      for (const node of firstSlots) {
        expect(secondSlots.includes(node)).toBe(false);
      }

      await first.unmount();
      await second.unmount();
    } finally {
      uninstallFakeDom();
    }
  });
});

describe("generic UI: toolbar contributions", () => {
  it("shows a new external panel's toolbar button and toggles it through the generic surface", async () => {
    installFakeDom();
    let cleanups = [];
    let mounted = null;
    try {
      const third = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
        label: "Third rail",
      });
      cleanups = [third.unregister];

      const panelVisibility = { sftp: true, status: false };
      const rerenderDock = () => {};
      const workbench = makeWorkbench({
        extensions: EXTERNAL_EXTENSIONS,
        panelVisibility,
        togglePanel: (key) => {
          panelVisibility[key] = !panelVisibility[key];
        },
      });
      workbench.togglePanel = (key) => {
        panelVisibility[key] = !panelVisibility[key];
      };

      mounted = await render(
        createElement(TopToolbar, {
          showSftpPanel: true,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          collapsed: false,
          onToggleCollapsed: () => {},
          onOpenSshConfig: () => {},
          onOpenScriptConfig: () => {},
          onOpenAgentConfig: () => {},
          onToggleSftpPanel: () => {},
          onToggleStatusPanel: () => {},
          onToggleCommandDraftPanel: () => {},
          onOpenSettings: () => {},
          busy: "",
          error: "",
          extensions: EXTERNAL_EXTENSIONS,
          workbench,
        }),
      );

      // The external button rendered with the plugin's label.
      const thirdButton = findElement(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.textContent.includes("Third rail"),
      );
      expect(thirdButton).toBeTruthy();

      // SFTP keeps the original label; the draft toggle stays app chrome.
      expect(mounted.container.textContent).toContain("SFTP panel");
      expect(mounted.container.textContent).toContain("Show command draft");

      // Clicking the new button toggles through the generic map.
      fireClick(thirdButton);
      expect(panelVisibility[THIRD_PANEL_KEY]).toBe(true);
      fireClick(thirdButton);
      expect(panelVisibility[THIRD_PANEL_KEY]).toBe(false);

      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      await mounted.unmount();
    } finally {
      cleanups.forEach((fn) => fn());
      uninstallFakeDom();
    }
  });

  it("drops the button when the extension is disabled", async () => {
    installFakeDom();
    try {
      const extensions = EXTERNAL_EXTENSIONS.map((extension) =>
        extension.id === "com.example.third" ? { ...extension, enabled: false } : extension,
      );
      const mounted = await render(
        createElement(TopToolbar, {
          showSftpPanel: false,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          collapsed: false,
          onToggleCollapsed: () => {},
          onOpenSshConfig: () => {},
          onOpenScriptConfig: () => {},
          onOpenAgentConfig: () => {},
          onToggleSftpPanel: () => {},
          onToggleStatusPanel: () => {},
          onToggleCommandDraftPanel: () => {},
          onOpenSettings: () => {},
          busy: "",
          error: "",
          extensions,
          workbench: makeWorkbench({ extensions, panelVisibility: {} }),
        }),
      );
      expect(mounted.container.textContent.includes("com.example.third panel")).toBe(false);
      // Builtin buttons stay.
      expect(mounted.container.textContent).toContain("SFTP panel");
      expect(mounted.container.textContent).toContain("status panel");
      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });
});

describe("generic UI: controller hosts and stores", () => {
  it("publishes the first snapshot after layout and never renders an undefined controller", async () => {
    installFakeDom();
    let cleanups = [];
    let mounted = null;
    try {
      const third = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
        // Instrument the panel render IN PLACE (same activation object):
        // record every controller the render received.
        wrapPanelRender: (props, baseRender) => baseRender(props),
      });
      cleanups = [third.unregister];
      const plugin = third.plugin;
      const seenControllers = third.seenControllers;

      const panelKey = third.panelKey;
      mounted = await render(
        createElement(
          Fragment,
          null,
          createElement(AppMainWorkspace, {
            workbench: makeWorkbench({
              extensions: EXTERNAL_EXTENSIONS,
              panelVisibility: { [panelKey]: true },
            }),
            acp: makeAcp(),
            showSftpPanel: false,
            showStatusPanel: false,
            showCommandDraftPanel: false,
            onOpenFileEditor: makeUi().onOpenFileEditor,
          }),
          createElement(ExternalControllerHost, { key: controllerHostKey(plugin), plugin }),
        ),
      );
      await act(async () => {});

      // No render ever saw an undefined controller: the waiting container
      // held the slot for the layout commit that publishes the snapshot.
      for (const controller of seenControllers) {
        expect(controller).not.toBeNull();
      }

      // The store (keyed by the activation object) reports ready with a
      // cached snapshot.
      const store = getControllerStore(plugin);
      expect(store).not.toBeNull();
      expect(store.isReady()).toBe(true);
      const snapshot = store.getSnapshot();
      expect(snapshot.ready).toBe(true);
      expect(snapshot.controller).not.toBeNull();
      expect(snapshot.controller.api.meta.pluginId).toBe("com.example.third");

      // A second getSnapshot returns the SAME object (cached, no loop).
      expect(store.getSnapshot()).toBe(snapshot);

      // The panel body shows the controller's data through render props.
      expect(mounted.container.textContent).toContain("clicks:0");

      // Disable: unregister first, flush, then unmount. The store lives as
      // long as the activation object is reachable (a WeakMap entry); the
      // explicit teardown is owner-checked — it deletes exactly this
      // object's entry and nothing any other activation owns.
      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      await mounted.unmount();
      removeControllerStore(plugin);
      expect(getControllerStore(plugin)).toBeNull();
    } finally {
      cleanups.forEach((fn) => fn());
      uninstallFakeDom();
    }
  });

  it("a controller render error is contained at the plugin boundary", async () => {
    installFakeDom();
    let unregister = null;
    let mounted = null;
    try {
      const crashing = {
        id: "com.example.crash",
        builtin: false,
        api: {},
        createController: () => {
          throw new Error("controller exploded");
        },
        panels: () => [],
        toolbar: () => [],
      };
      unregister = registerPlugin(crashing);
      mounted = await render(
        createElement(ExternalControllerHost, { plugin: crashing }),
      );
      // The host rendered (error boundary fallback = null) without throwing.
      expect(mounted.container).toBeTruthy();
      unregister();
      unregister = null;
      await act(async () => {});
      await mounted.unmount();
    } finally {
      unregister?.();
      uninstallFakeDom();
    }
  });

  it("a panel render error shows the placeholder, not a crashed dock", async () => {
    installFakeDom();
    let cleanups = [];
    let mounted = null;
    try {
      const crashing = {
        id: "com.example.panelcrash",
        builtin: false,
        api: { meta: { pluginId: "com.example.panelcrash" } },
        createController: () => ({ ok: true }),
        panels: () => [
          {
            id: "panelcrash.panel",
            key: "panelcrash.panel",
            order: 50,
            title: "Crash Panel",
            render: () => {
              throw new Error("panel exploded");
            },
          },
        ],
        toolbar: () => [],
      };
      const unregister = registerPlugin(crashing);
      cleanups = [unregister];

      const extensions = [
        ...EXTERNAL_EXTENSIONS,
        {
          id: "com.example.panelcrash",
          displayName: "Crash",
          version: "1.0.0",
          apiVersion: 1,
          builtin: false,
          enabled: true,
          contributes: { panels: [{ id: "panelcrash.panel", order: 50 }] },
        },
      ];
      mounted = await render(
        createElement(
          Fragment,
          null,
          createElement(AppMainWorkspace, {
            workbench: makeWorkbench({
              extensions,
              panelVisibility: { "panelcrash.panel": true },
            }),
            acp: makeAcp(),
            showSftpPanel: false,
            showStatusPanel: false,
            showCommandDraftPanel: false,
            onOpenFileEditor: makeUi().onOpenFileEditor,
          }),
          createElement(ExternalControllerHost, { key: controllerHostKey(crashing), plugin: crashing }),
        ),
      );
      await act(async () => {});

      // The terminal and builtin dock survive; the crashed panel shows the
      // placeholder instead of blanking the workspace.
      expect(mounted.container.textContent).toContain("prod-box");
      expect(mounted.container.textContent).toContain("Crash Panel");

      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      await mounted.unmount();
    } finally {
      cleanups.forEach((fn) => fn());
      uninstallFakeDom();
    }
  });
});

describe("generic UI: registry subscription", () => {
  it("notifies consumers on register and unregister (late registrations re-render)", () => {
    const seen = [];
    const unsubscribe = subscribeRegistry(() => seen.push(getRegistryVersion()));
    const before = getRegistryVersion();
    const third = registerExternalPlugin("com.example.third", { panelKey: THIRD_PANEL_KEY });
    third.unregister();
    unsubscribe();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(getRegistryVersion()).toBeGreaterThan(before);
    expect(getPlugin("com.example.third")).toBeNull();
  });

  it("a stale unregister cannot delete a newer registration (owner safety)", () => {
    const first = registerExternalPlugin("com.example.third", { panelKey: THIRD_PANEL_KEY });
    // Simulate the old activation's late cleanup: dispose twice, then a NEW
    // registration wins the id, then the old cleanup runs once more.
    const staleUnregister = first.unregister;
    staleUnregister();
    const second = registerExternalPlugin("com.example.third", { panelKey: THIRD_PANEL_KEY });
    staleUnregister(); // must NOT remove the second registration
    expect(getPlugin("com.example.third")).not.toBeNull();
    expect(getPlugin("com.example.third").api.meta.pluginId).toBe("com.example.third");
    second.unregister();
    expect(getPlugin("com.example.third")).toBeNull();
  });
});

describe("generic UI: useWorkbench integration (no mocks of the workbench)", () => {
  const installWorkbenchCommands = () => {
    commandHandlers.set("list_ssh_configs", async () => []);
    commandHandlers.set("list_scripts", async () => []);
    commandHandlers.set("list_shell_sessions", async () => [
      { id: "sess-1", configId: "cfg-1", configName: "box", currentDir: "/var" },
    ]);
    commandHandlers.set("sftp_default_download_dir", async () => "");
    commandHandlers.set("list_extensions", async () => EXTERNAL_EXTENSIONS);
    commandHandlers.set("get_cached_server_status", async () => null);
    commandHandlers.set("sftp_list_dir", async () => ({ path: "/var", entries: [] }));
    commandHandlers.set("fetch_server_status", async () => null);
  };

  const renderWorkbenchProbe = async () => {
    let latest = null;
    const container = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(container);
    const root = createRoot(container);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const Probe = () => {
      latest = useWorkbench();
      return null;
    };
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(Probe)));
    });
    return {
      root,
      get wb() {
        return latest;
      },
    };
  };

  it("exposes the generic visibility surface and the compat keys together", async () => {
    installFakeDom();
    try {
      installWorkbenchCommands();
      const mounted = await renderWorkbenchProbe();

      // New generic keys.
      expect(typeof mounted.wb.showPanel).toBe("function");
      expect(typeof mounted.wb.hidePanel).toBe("function");
      expect(typeof mounted.wb.togglePanel).toBe("function");
      expect(Array.isArray(mounted.wb.pluginControllerHosts)).toBe(true);

      // Every compat key still present (the full legacy surface).
      for (const key of [
        "showSftpPanel", "setShowSftpPanel",
        "showStatusPanel", "setShowStatusPanel",
        "showCommandDraftPanel", "setShowCommandDraftPanel",
      ]) {
        expect(key in mounted.wb).toBe(true);
      }

      // Defaults unchanged: sftp/status/draft hidden without explicit action.
      expect(mounted.wb.showSftpPanel).toBe(false);
      expect(mounted.wb.showStatusPanel).toBe(false);
      expect(mounted.wb.showCommandDraftPanel).toBe(false);

      // The compat setters drive the same map the generic surface reads.
      await act(async () => {
        mounted.wb.setShowSftpPanel(true);
      });
      expect(mounted.wb.showSftpPanel).toBe(true);
      await act(async () => {
        mounted.wb.togglePanel("status");
      });
      expect(mounted.wb.showStatusPanel).toBe(true);
      await act(async () => {
        mounted.wb.hidePanel("status");
      });
      expect(mounted.wb.showStatusPanel).toBe(false);

      await act(async () => {
        mounted.root.unmount();
      });
    } finally {
      commandHandlers.clear();
      uninstallFakeDom();
    }
  });

  it("a defaultVisible external panel appears after registration (install → visible)", async () => {
    installFakeDom();
    let cleanups = [];
    try {
      installWorkbenchCommands();
      const mounted = await renderWorkbenchProbe();
      const wb = () => mounted.wb;

      // Before the external registration: builtin defaults stay hidden.
      expect(wb().showSftpPanel).toBe(false);
      expect(wb().showStatusPanel).toBe(false);

      // Install (register) the external plugin with defaultVisible: true.
      const third = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
        defaultVisible: true,
      });
      cleanups = [third.unregister];

      // The registry change re-renders the workbench; the first-seen default
      // applies in the effect: the new panel is visible after install.
      await act(async () => {});
      await act(async () => {});
      expect(wb().panelVisibility?.[THIRD_PANEL_KEY]).toBe(true);

      // Builtin defaults are untouched: still hidden.
      expect(wb().showSftpPanel).toBe(false);
      expect(wb().showStatusPanel).toBe(false);

      // Hiding it sticks (defaults apply exactly once).
      await act(async () => {
        wb().hidePanel(THIRD_PANEL_KEY);
      });
      expect(wb().panelVisibility?.[THIRD_PANEL_KEY]).toBe(false);
      await act(async () => {});
      expect(wb().panelVisibility?.[THIRD_PANEL_KEY]).toBe(false);

      // Disabled → unregister → the panel and its controller are gone.
      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      expect(getPlugin("com.example.third")).toBeNull();
      // A stale visibility entry is inert: nothing renders it.

      await act(async () => {
        mounted.root.unmount();
      });
    } finally {
      cleanups.forEach((fn) => fn());
      commandHandlers.clear();
      uninstallFakeDom();
    }
  });

  it("an external panel that does not ask to be visible starts hidden", async () => {
    installFakeDom();
    let cleanups = [];
    try {
      installWorkbenchCommands();
      const mounted = await renderWorkbenchProbe();
      const wb = () => mounted.wb;

      // No `defaultVisible`: installing a plugin must not rearrange the
      // dock. Visibility is not persisted, so a panel that opened itself on
      // install would reopen on every launch.
      const third = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
      });
      cleanups = [third.unregister];

      await act(async () => {});
      await act(async () => {});
      expect(wb().panelVisibility?.[THIRD_PANEL_KEY]).toBeUndefined();

      // The toolbar button still opens it on demand.
      await act(async () => {
        wb().togglePanel(THIRD_PANEL_KEY);
      });
      expect(wb().panelVisibility?.[THIRD_PANEL_KEY]).toBe(true);

      await act(async () => {
        mounted.root.unmount();
      });
    } finally {
      cleanups.forEach((fn) => fn());
      commandHandlers.clear();
      uninstallFakeDom();
    }
  });

  it("useWorkbench injects ctx.api into the builtin controllers (poll/listeners armed)", async () => {
    installFakeDom();
    try {
      installWorkbenchCommands();
      const mounted = await renderWorkbenchProbe();

      // The registry holds both builtins with their api objects.
      expect(getPlugin("eshell.sftp")?.api?.meta?.pluginId).toBe("eshell.sftp");
      expect(getPlugin("eshell.server-monitor")?.api?.meta?.pluginId).toBe("eshell.server-monitor");

      // Old keys all still callable (the full legacy return surface).
      expect(typeof mounted.wb.connectServer).toBe("function");
      expect(typeof mounted.wb.saveScript).toBe("function");
      expect(typeof mounted.wb.handleDeleteSsh).toBe("function");
      expect(typeof mounted.wb.handleNicChange).toBe("function");
      expect(typeof mounted.wb.handleDownloadDirectoryChange).toBe("function");
      expect(typeof mounted.wb.formatBytes).toBe("function");

      // The Settings/Terminal callbacks survived the adapter (not dropped).
      expect(typeof mounted.wb.setTheme).toBe("function");
      expect(typeof mounted.wb.setWallpaper).toBe("function");
      expect(typeof mounted.wb.resizePty).toBe("function");
      expect(typeof mounted.wb.sendPtyInput).toBe("function");

      await act(async () => {
        mounted.root.unmount();
      });
    } finally {
      commandHandlers.clear();
      uninstallFakeDom();
    }
  });
});

// ---------------------------------------------------------------------------
// Activation-generation sequences: StrictMode's simulated effect cleanup, and
// a rapid same-id unregister/re-register under one act batch. These
// reproduce real races the suite above could not:
//   - a store deleted on StrictMode cleanup stranding the runner and the
//     panel on two different stores (panel stuck not-ready forever);
//   - a host keyed only by plugin id reusing the previous activation's
//     controller state after a rapid off/on;
//   - an old activation's late cleanup removing the new activation's store.
// ---------------------------------------------------------------------------
describe("generic UI: activation generations (StrictMode, rapid off/on)", () => {
  const installWorkbenchCommands = () => {
    commandHandlers.set("list_ssh_configs", async () => []);
    commandHandlers.set("list_scripts", async () => []);
    commandHandlers.set("list_shell_sessions", async () => [
      { id: "sess-1", configId: "cfg-1", configName: "box", currentDir: "/var" },
    ]);
    commandHandlers.set("sftp_default_download_dir", async () => "");
    commandHandlers.set("list_extensions", async () => EXTERNAL_EXTENSIONS);
    commandHandlers.set("get_cached_server_status", async () => null);
    commandHandlers.set("sftp_list_dir", async () => ({ path: "/var", entries: [] }));
    commandHandlers.set("fetch_server_status", async () => null);
  };

  it("StrictMode simulated cleanup does not strand the panel on a dead store", async () => {
    installFakeDom();
    let cleanups = [];
    // Declared outside try so the finally block can unmount them when an
    // assertion fails mid-test (root mounted, registrations still live).
    let container = null;
    let root = null;
    try {
      const third = registerExternalPlugin("com.example.third", { panelKey: THIRD_PANEL_KEY });
      cleanups = [third.unregister];

      // REAL StrictMode: effects run mount -> simulated unmount -> remount.
      // The runner's publish effect and the panel's subscription must both
      // land back on the SAME store afterwards.
      const workbench = makeWorkbench({
        extensions: EXTERNAL_EXTENSIONS,
        panelVisibility: { [third.panelKey]: true },
      });

      container = globalThis.document.createElement("div");
      globalThis.document.body.appendChild(container);
      root = createRoot(container);
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      const App = () =>
        createElement(
          StrictMode,
          null,
          createElement(
            Fragment,
            null,
            createElement(AppMainWorkspace, {
              workbench,
              acp: makeAcp(),
              showSftpPanel: false,
              showStatusPanel: false,
              showCommandDraftPanel: false,
              onOpenFileEditor: makeUi().onOpenFileEditor,
            }),
            createElement(ExternalControllerHost, {
              key: controllerHostKey(third.plugin),
              plugin: third.plugin,
            }),
          ),
        );
      await act(async () => {
        root.render(createElement(App));
      });
      // Extra commits: any re-render after the simulated cleanup.
      await act(async () => {});
      await act(async () => {});

      // The panel is ready and shows the controller's counter: the runner
      // and the panel agreed on one store through the StrictMode cycle.
      expect(container.textContent).toContain("clicks:0");
      expect(container.textContent).toContain("api:com.example.third");

      // The store is the same object the activation owns, still reachable.
      const store = getControllerStore(third.plugin);
      expect(store).not.toBeNull();
      expect(store.isReady()).toBe(true);

      // A second publish (a controller state change) still reaches the panel.
      act(() => {
        store.publish({ clicks: 5, increment: () => {}, api: third.api });
      });
      await act(async () => {});
      expect(container.textContent).toContain("clicks:5");

      // Teardown order matters: the registry unregisters (notifying the
      // subscribed hosts -> React schedules), the pending React work is
      // flushed INSIDE act, and only then the root unmounts — also inside
      // act. Unmounting outside act lets react-dom's scheduler run its
      // pending queue after the fake DOM is gone (window is not defined,
      // uncaught ReferenceError).
      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      await act(async () => {
        root.unmount();
      });
      container.remove();
    } finally {
      // A failed assertion can land here with the root still mounted and the
      // registry still holding registrations: unregister, flush whatever
      // React work that schedules, unmount inside act, and only then drop
      // the fake DOM. Otherwise react-dom's scheduler drains its pending
      // queue after `window` is gone (uncaught ReferenceError).
      cleanups.forEach((fn) => fn());
      await act(async () => {});
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      container?.remove();
      uninstallFakeDom();
    }
  });

  it("rapid same-id unregister/re-register rebuilds controller state; a stale cleanup spares the new store; the terminal never remounts", async () => {
    installFakeDom();
    let cleanups = [];
    // Declared outside try so the finally block can unmount them when an
    // assertion fails mid-test (same as the StrictMode test above).
    let container = null;
    let root = null;
    try {
      installWorkbenchCommands();

      // The App-level tree, exactly like AppWorkspace: the terminal panel
      // renders inside AppMainWorkspace, the hosts as siblings rendered
      // from useWorkbench's own pluginControllerHosts.
      // `defaultVisible: true` because this test asserts on the panel's
      // rendered content; panel visibility is not its subject.
      const first = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
        defaultVisible: true,
      });
      const staleUnregister = first.unregister;

      let latest = null;
      container = globalThis.document.createElement("div");
      globalThis.document.body.appendChild(container);
      root = createRoot(container);
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      // NOTE: the App-level tree mirrors App.jsx: useWorkbench runs in the
      // PARENT (Shell), the dock and the hosts render in a CHILD (Inner)
      // reading the snapshot through props. A single-level Shell that
      // assigns `latest` and consumes it in the same body would always read
      // the PREVIOUS render's hosts array (parents render before children),
      // and a registry notification would never land the new host element.
      const Inner = ({ wb }) =>
        createElement(
          Fragment,
          null,
          createElement(AppMainWorkspace, {
            workbench: wb,
            acp: makeAcp(),
            onOpenFileEditor: makeUi().onOpenFileEditor,
          }),
          wb.pluginControllerHosts,
        );
      const Shell = () => {
        latest = useWorkbench();
        return createElement(Inner, { wb: latest });
      };
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(Shell)));
      });
      await act(async () => {});
      expect(container.textContent).toContain("clicks:0");

      // The terminal is identified by the active session's config name ("box"
      // from the mocked list_shell_sessions) on the terminal root section.
      const terminalCount = () =>
        findElements(
          container,
          (node) => node.textContent.includes("box") && node.className?.includes("bg-panel"),
        ).length;
      const terminalBefore = terminalCount();
      expect(terminalBefore).toBeGreaterThanOrEqual(1);

      // Rapid off/on inside one act batch. The registry's contract: the id
      // must be released before it can be re-registered (a second
      // registration while the first owns the id is a no-op). The real
      // loader sequence is disable (unregister) then enable (register); the
      // old activation's LATE cleanup may still run afterwards.
      staleUnregister();
      const second = registerExternalPlugin("com.example.third", {
        panelKey: THIRD_PANEL_KEY,
        defaultVisible: true,
        controller: (ctx) => ({
          clicks: 0,
          increment: () => {},
          api: ctx.api,
          generation: "second",
        }),
      });
      cleanups = [second.unregister];
      // The OLD activation's late cleanup arrives a second time, after the
      // new one is registered: it must be a no-op against the new registry
      // slot (owner-checked) and must not remove the new activation's store.
      staleUnregister();
      await act(async () => {});
      await act(async () => {});

      // The new activation owns the registry slot and its own store.
      expect(getPlugin("com.example.third")).toBe(second.plugin);
      const newStore = getControllerStore(second.plugin);
      expect(newStore).not.toBeNull();
      expect(newStore.isReady()).toBe(true);
      expect(newStore.getSnapshot().controller.generation).toBe("second");

      // The old object's store is a different entry; the stale removal is
      // owner-checked by object identity and cannot touch the new one.
      expect(getControllerStore(first.plugin)).not.toBe(newStore);

      // The panel shows the NEW activation's data through render props.
      expect(container.textContent).toContain("clicks:0");
      expect(container.textContent).toContain("api:com.example.third");

      // The core terminal did not remount: the same terminal host count.
      expect(terminalCount()).toBe(terminalBefore);

      // Teardown order (see the StrictMode test above): unregister inside
      // this turn, flush the registry notifications' scheduled React work
      // inside act, then unmount the root inside act — never outside, or
      // react-dom's scheduler runs its pending queue after the fake DOM is
      // gone (uncaught ReferenceError: window is not defined).
      cleanups.forEach((fn) => fn());
      cleanups = [];
      await act(async () => {});
      await act(async () => {
        root.unmount();
      });
      container.remove();
    } finally {
      // Same failed-assertion safety as the StrictMode test above.
      cleanups.forEach((fn) => fn());
      await act(async () => {});
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      container?.remove();
      commandHandlers.clear();
      uninstallFakeDom();
    }
  });
});
