/**
 * The rail's Panels section must scroll rather than push the Quick section
 * off the bottom.
 *
 * Every enabled plugin contributes a button, so the list is unbounded. The
 * failure this guards against is a rail whose Settings button becomes
 * unreachable once enough plugins are installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

import TopToolbar from "../layout/TopToolbar.jsx";
import { I18nProvider } from "../../lib/i18n.js";
import { registerPlugin, unregisterPlugin } from "../../plugins/registry.js";
import { installFakeDom, uninstallFakeDom, findElement, findElements } from "../../test/fake-dom.js";
import { render } from "../../test/react-render.js";

const textOf = (node) => (node?.textContent ?? "").toString();

/** Registers N external plugins, each contributing one panel + toolbar item. */
function registerManyPlugins(count) {
  const unregisters = [];
  for (let index = 0; index < count; index += 1) {
    const id = `com.example.p${index}`;
    const panelKey = `${id}.panel`;
    unregisters.push(
      registerPlugin({
        id,
        builtin: false,
        panels: () => [{ id: panelKey, key: panelKey, order: 100 + index, title: `P${index}` }],
        toolbar: () => [
          {
            id: `${id}.toolbar`,
            key: `${id}.toolbar`,
            panelId: panelKey,
            label: `Plugin ${index}`,
            icon: "server",
            order: 100 + index,
          },
        ],
      }),
    );
  }
  return unregisters;
}

const extensionsFor = (count) => [
  {
    id: "eshell.sftp",
    displayName: "SFTP",
    version: "1.0.0",
    apiVersion: 1,
    builtin: true,
    enabled: true,
    contributes: { panels: [{ id: "sftp", order: 10 }] },
  },
  ...Array.from({ length: count }, (_, index) => ({
    id: `com.example.p${index}`,
    displayName: `Plugin ${index}`,
    version: "1.0.0",
    apiVersion: 1,
    builtin: false,
    enabled: true,
    contributes: { panels: [{ id: `com.example.p${index}.panel`, order: 100 + index }] },
  })),
];

async function renderToolbar(count) {
  const workbench = {
    panelVisibility: {},
    togglePanel: () => {},
  };
  return render(
    createElement(
      I18nProvider,
      null,
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
        extensions: extensionsFor(count),
        workbench,
      }),
    ),
  );
}

/** The Panels section's scrollable body, found by its class contract. */
const scrollBody = (container) =>
  findElement(
    container,
    (node) =>
      typeof node.className === "string" &&
      node.className.includes("overflow-y-auto") &&
      node.className.includes("scroll-region"),
  );

describe("rail overflow with many plugins", () => {
  let unregisters = [];

  beforeEach(() => {
    installFakeDom();
  });

  afterEach(() => {
    unregisters.forEach((fn) => fn());
    unregisters = [];
    uninstallFakeDom();
  });

  it("renders every contributed button", async () => {
    unregisters = registerManyPlugins(12);
    const mounted = await renderToolbar(12);

    const text = textOf(mounted.container);
    for (let index = 0; index < 12; index += 1) {
      expect(text, `plugin ${index} must have a button`).toContain(`Plugin ${index}`);
    }

    await mounted.unmount();
  });

  it("puts the Panels buttons in a scrollable region", async () => {
    unregisters = registerManyPlugins(12);
    const mounted = await renderToolbar(12);

    const body = scrollBody(mounted.container);
    expect(body, "the Panels body must be a scroll region").toBeTruthy();
    // The contributed buttons live inside it, so the region is the one that
    // actually overflows rather than an empty wrapper.
    expect(textOf(body)).toContain("Plugin 0");
    expect(textOf(body)).toContain("Plugin 11");

    await mounted.unmount();
  });

  it("keeps Settings reachable no matter how many plugins are installed", async () => {
    unregisters = registerManyPlugins(30);
    const mounted = await renderToolbar(30);

    // Settings is in the Quick section, outside the scroll region, so it is
    // always laid out — it cannot be pushed off the rail.
    const settings = findElement(
      mounted.container,
      (node) => node.tagName === "BUTTON" && textOf(node).includes("Settings"),
    );
    expect(settings).toBeTruthy();

    const body = scrollBody(mounted.container);
    expect(textOf(body)).not.toContain("Settings");

    await mounted.unmount();
  });

  it("gives the scroll region a min-height of zero so it can shrink", async () => {
    unregisters = registerManyPlugins(3);
    const mounted = await renderToolbar(3);

    // Without `min-h-0` a flex child refuses to shrink below its content and
    // the section would overflow its parent instead of scrolling.
    const body = scrollBody(mounted.container);
    expect(body.className).toContain("min-h-0");
    expect(body.className).toContain("flex-1");

    await mounted.unmount();
  });

  it("still renders the contributed buttons when collapsed", async () => {
    unregisters = registerManyPlugins(5);
    const workbench = { panelVisibility: {}, togglePanel: () => {} };
    const mounted = await render(
      createElement(
        I18nProvider,
        null,
        createElement(TopToolbar, {
          showSftpPanel: false,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          collapsed: true,
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
          extensions: extensionsFor(5),
          workbench,
        }),
      ),
    );

    // Collapsed buttons are icon-only, so the label lives in the title.
    const titles = findElements(mounted.container, (node) => node.tagName === "BUTTON").map(
      (node) => node.getAttribute?.("title") ?? "",
    );
    expect(titles.some((title) => title.includes("Plugin 0"))).toBe(true);
    expect(titles.some((title) => title.includes("Plugin 4"))).toBe(true);

    await mounted.unmount();
  });
});
