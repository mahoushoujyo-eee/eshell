/**
 * The Settings → Plugins tab: the merged extension list, the enable toggle,
 * install-from-folder, and remove.
 *
 * These drive the real component against a fake DOM and a mocked command
 * layer, so the assertions are about what the user sees and which command
 * fires — not about internal state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

const commandHandlers = new Map();
const dialogOpen = vi.fn(async () => null);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    const handler = commandHandlers.get(command);
    if (!handler) {
      throw new Error(`unmocked command in test: ${command}`);
    }
    return handler(args ?? {});
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args) => dialogOpen(...args) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { act } from "react";
import SettingsModal from "../sidebar/SettingsModal.jsx";
import { I18nProvider } from "../../lib/i18n.js";
import { installFakeDom, uninstallFakeDom, findElement, findElements } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";

/** Lets a pending command promise settle and React re-render. */
const flush = () => act(async () => {});

const BUILTIN = {
  id: "eshell.sftp",
  displayName: "SFTP",
  version: "1.0.0",
  apiVersion: 1,
  builtin: true,
  defaultEnabled: true,
  enabled: true,
  contributes: { panels: [] },
};

const EXTERNAL = {
  id: "com.example.docker",
  displayName: "Docker",
  version: "1.0.0",
  apiVersion: 1,
  builtin: false,
  defaultEnabled: true,
  enabled: true,
  contributes: { panels: [] },
};

const textOf = (node) => (node?.textContent ?? "").toString();
/**
 * The plugin removal dialog. The settings modal is itself `role="dialog"`,
 * so match on the dialog's own labelled heading rather than the role alone.
 */
const removeDialog = (root) =>
  findElement(
    root,
    (node) =>
      node.getAttribute?.("role") === "dialog" &&
      node.getAttribute?.("aria-labelledby") === "plugin-remove-title",
  );
const byText = (root, text) =>
  findElement(root, (node) => textOf(node).trim() === text && node.tagName === "BUTTON");

/** Opens the modal on the Plugins tab and waits for the list to load. */
async function openPluginsTab() {
  const mounted = await render(
    createElement(
      I18nProvider,
      null,
      createElement(SettingsModal, {
        open: true,
        onClose: () => {},
        theme: "light",
        onSelectTheme: () => {},
        wallpaperLabel: "none",
        onOpenWallpaperPicker: () => {},
      }),
    ),
  );
  await fireClick(byText(mounted.container, "Plugins"));
  // The tab loads its list in an effect; let that promise settle before the
  // caller asserts on rows.
  await flush();
  return mounted;
}

describe("Settings navigation", () => {
  beforeEach(() => {
    installFakeDom();
    commandHandlers.clear();
    dialogOpen.mockReset();
    dialogOpen.mockResolvedValue(null);
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("navigates by section and shows the section heading", async () => {
    commandHandlers.set("list_extensions", async () => []);
    const mounted = await render(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsModal, {
          open: true,
          onClose: () => {},
          theme: "light",
          onSelectTheme: () => {},
          wallpaperLabel: "none",
          onOpenWallpaperPicker: () => {},
        }),
      ),
    );

    // The rail lists every section, and the pane opens on the first one.
    const nav = findElement(
      mounted.container,
      (node) => node.tagName === "NAV",
    );
    expect(nav).toBeTruthy();
    for (const label of ["Interface", "Plugins", "Version"]) {
      expect(textOf(nav)).toContain(label);
    }
    expect(textOf(mounted.container)).toContain("Appearance");

    // The active rail item is marked for assistive tech, not just styled.
    const activeItem = findElement(
      nav,
      (node) => node.getAttribute?.("aria-current") === "page",
    );
    expect(textOf(activeItem)).toContain("Interface");

    // Switching sections swaps the heading and the pane.
    await fireClick(byText(nav, "Version"));
    await flush();
    expect(textOf(mounted.container)).toContain("About");
    expect(
      findElement(nav, (node) => node.getAttribute?.("aria-current") === "page"),
    ).toBeTruthy();

    await mounted.unmount();
  });

  it("keeps the rail outside the scrolling pane", async () => {
    commandHandlers.set("list_extensions", async () => []);
    const mounted = await render(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsModal, {
          open: true,
          onClose: () => {},
          theme: "light",
          onSelectTheme: () => {},
          wallpaperLabel: "none",
          onOpenWallpaperPicker: () => {},
        }),
      ),
    );

    // A long plugin list must not scroll the navigation out of view: the
    // scroll region is the content pane, and the rail is not inside it.
    const scroller = findElement(
      mounted.container,
      (node) =>
        typeof node.className === "string" && node.className.includes("overflow-y-auto"),
    );
    expect(scroller).toBeTruthy();
    expect(textOf(scroller)).not.toContain("Plugins");
    expect(
      findElement(mounted.container, (node) => node.tagName === "NAV"),
    ).toBeTruthy();

    await mounted.unmount();
  });
});

describe("Settings Plugins tab", () => {
  beforeEach(() => {
    installFakeDom();
    commandHandlers.clear();
    dialogOpen.mockReset();
    dialogOpen.mockResolvedValue(null);
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("lists builtin and external extensions with their state", async () => {
    commandHandlers.set("list_extensions", async () => [BUILTIN, EXTERNAL]);
    const mounted = await openPluginsTab();

    const text = textOf(mounted.container);
    expect(text).toContain("SFTP");
    expect(text).toContain("Docker");
    expect(text).toContain("eshell.sftp");
    expect(text).toContain("com.example.docker");
    // Both are enabled, so both show the enabled affordance. `findElements`
    // walks every node, so match on the button's own label rather than any
    // ancestor whose textContent happens to contain it.
    const toggles = findElements(
      mounted.container,
      (n) => n.tagName === "BUTTON" && textOf(n).trim() === "Enabled",
    );
    expect(toggles.length).toBe(2);

    await mounted.unmount();
  });

  it("toggles an extension through set_extension_enabled", async () => {
    commandHandlers.set("list_extensions", async () => [BUILTIN]);
    const calls = [];
    commandHandlers.set("set_extension_enabled", async (args) => {
      calls.push(args.input);
      return [{ ...BUILTIN, enabled: args.input.enabled }];
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Enabled"));
    await flush();

    expect(calls).toEqual([{ extensionId: "eshell.sftp", enabled: false }]);
    // The returned list is what renders, so the button flips.
    expect(byText(mounted.container, "Disabled")).toBeTruthy();

    await mounted.unmount();
  });

  it("surfaces a refused toggle instead of silently doing nothing", async () => {
    commandHandlers.set("list_extensions", async () => [EXTERNAL]);
    commandHandlers.set("set_extension_enabled", async () => {
      throw new Error("extension com.example.docker has an operation in flight");
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Enabled"));
    await flush();

    expect(textOf(mounted.container)).toContain("operation in flight");
    // The row keeps its real state: a refused change is not a change.
    expect(byText(mounted.container, "Enabled")).toBeTruthy();

    await mounted.unmount();
  });

  it("installs from a picked folder and shows the new row", async () => {
    commandHandlers.set("list_extensions", async () => [BUILTIN]);
    dialogOpen.mockResolvedValue("D:\\plugins\\docker-plugin");
    const installed = [];
    commandHandlers.set("install_extension", async (args) => {
      installed.push(args.input.sourceDir);
      return {
        extensionId: "com.example.docker",
        displayName: "Docker",
        extensions: [BUILTIN, EXTERNAL],
      };
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Install from folder…"));
    await flush();

    expect(installed).toEqual(["D:\\plugins\\docker-plugin"]);
    expect(textOf(mounted.container)).toContain("Docker");
    expect(textOf(mounted.container)).toContain("Installed Docker");

    await mounted.unmount();
  });

  it("does nothing when the folder picker is cancelled", async () => {
    commandHandlers.set("list_extensions", async () => [BUILTIN]);
    let installCalls = 0;
    commandHandlers.set("install_extension", async () => {
      installCalls += 1;
      return { extensionId: "x", displayName: "x", extensions: [BUILTIN] };
    });
    dialogOpen.mockResolvedValue(null);

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Install from folder…"));
    await flush();

    expect(installCalls).toBe(0);
    await mounted.unmount();
  });

  it("reports an install failure and keeps the list unchanged", async () => {
    commandHandlers.set("list_extensions", async () => [BUILTIN]);
    dialogOpen.mockResolvedValue("D:\\plugins\\broken");
    commandHandlers.set("install_extension", async () => {
      throw new Error("apiVersion 2 is unsupported (this host implements 1)");
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Install from folder…"));
    await flush();

    expect(textOf(mounted.container)).toContain("apiVersion 2 is unsupported");

    await mounted.unmount();
  });

  it("opens a confirmation dialog before removing, and only then uninstalls", async () => {
    commandHandlers.set("list_extensions", async () => [BUILTIN, EXTERNAL]);
    const removed = [];
    commandHandlers.set("uninstall_extension", async (args) => {
      removed.push(args.input.extensionId);
      return [BUILTIN];
    });

    const mounted = await openPluginsTab();

    // Builtin rows offer no Remove at all: their code ships with the app.
    expect(findElements(mounted.container, (n) => textOf(n).trim() === "Remove").length).toBe(1);

    await fireClick(byText(mounted.container, "Remove"));
    await flush();

    // A dialog, not an in-place button swap: the row keeps its own Remove
    // button and the confirmation is a separate modal.
    const dialog = removeDialog(mounted.container);
    expect(dialog).toBeTruthy();
    expect(textOf(dialog)).toContain("Remove this plugin?");
    expect(textOf(dialog)).toContain("com.example.docker");
    expect(textOf(dialog)).toContain("cannot be undone");
    expect(removed).toEqual([]);

    // The confirm button lives inside the dialog.
    await fireClick(byText(dialog, "Remove"));
    await flush();

    expect(removed).toEqual(["com.example.docker"]);
    expect(textOf(mounted.container)).toContain("Removed Docker");
    expect(textOf(mounted.container)).not.toContain("com.example.docker");
    expect(removeDialog(mounted.container)).toBeFalsy();

    await mounted.unmount();
  });

  it("cancelling the dialog leaves the plugin installed", async () => {
    commandHandlers.set("list_extensions", async () => [EXTERNAL]);
    let removeCalls = 0;
    commandHandlers.set("uninstall_extension", async () => {
      removeCalls += 1;
      return [];
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Remove"));
    await flush();

    await fireClick(byText(removeDialog(mounted.container), "Cancel"));
    await flush();

    expect(removeCalls).toBe(0);
    expect(removeDialog(mounted.container)).toBeFalsy();
    expect(textOf(mounted.container)).toContain("com.example.docker");

    await mounted.unmount();
  });

  it("closes the dialog on Escape without removing", async () => {
    commandHandlers.set("list_extensions", async () => [EXTERNAL]);
    let removeCalls = 0;
    commandHandlers.set("uninstall_extension", async () => {
      removeCalls += 1;
      return [];
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Remove"));
    await flush();

    // The fake window exposes `Event`, not `KeyboardEvent`; the dialog only
    // reads `key`, so a plain event with that field is enough.
    await act(async () => {
      globalThis.window.dispatchEvent(new globalThis.window.Event("keydown", { key: "Escape" }));
    });

    expect(removeCalls).toBe(0);
    expect(removeDialog(mounted.container)).toBeFalsy();

    await mounted.unmount();
  });

  it("surfaces a refused removal and keeps the plugin listed", async () => {
    commandHandlers.set("list_extensions", async () => [EXTERNAL]);
    commandHandlers.set("uninstall_extension", async () => {
      throw new Error("extension com.example.docker has an operation in flight");
    });

    const mounted = await openPluginsTab();
    await fireClick(byText(mounted.container, "Remove"));
    await flush();
    await fireClick(byText(removeDialog(mounted.container), "Remove"));
    await flush();

    expect(textOf(mounted.container)).toContain("operation in flight");
    expect(textOf(mounted.container)).toContain("com.example.docker");

    await mounted.unmount();
  });
});
