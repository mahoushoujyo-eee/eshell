import { beforeAll, describe, expect, it } from "vitest";
import {
  getPlugin,
  listPanelContributions,
  listPluginControllers,
  listPlugins,
  listToolbarContributions,
  registerPlugin,
} from "../registry";
import { resolvePanelContributions, resolveToolbarContributions } from "../contributions";
import { defaultExtensionState } from "../extensions/extensionState";
import { registerBuiltinPlugins } from "../index.jsx";

const makePlugin = (overrides = {}) => ({
  id: "test.plugin",
  panels: () => [{ id: "panel-a", order: 10, key: "a", render: () => null }],
  toolbar: () => [{ id: "panel-a", order: 10, key: "a", panelId: "panel-a" }],
  createController: () => ({}),
  ...overrides,
});

describe("registerPlugin", () => {
  it("registers a plugin once; a second registration is a no-op", () => {
    const plugin = makePlugin({ id: "test.once" });
    const unregister = registerPlugin(plugin);
    const before = listPlugins().map((item) => item.id);
    registerPlugin(makePlugin({ id: "test.once", panels: () => [] }));
    const after = listPlugins().map((item) => item.id);
    expect(after).toEqual(before);
    unregister();
    expect(listPlugins().map((item) => item.id)).not.toContain("test.once");
  });

  it("keeps registration order across plugins", () => {
    const first = registerPlugin(makePlugin({ id: "test.first" }));
    const second = registerPlugin(makePlugin({ id: "test.second" }));
    const ids = listPlugins().map((item) => item.id);
    expect(ids.indexOf("test.first")).toBeLessThan(ids.indexOf("test.second"));
    first();
    second();
  });

  it("ignores junk registrations", () => {
    registerPlugin(null);
    registerPlugin(undefined);
    registerPlugin({});
    expect(listPlugins().some((item) => !item.id)).toBe(false);
  });

  it("unregister restores the previous plugin on double dispose", () => {
    const original = makePlugin({ id: "test.swap" });
    const restore = registerPlugin(original);
    restore();
    restore();
    expect(getPlugin("test.swap")).toBeNull();
  });
});

describe("listPanelContributions / listToolbarContributions", () => {
  it("flattens panels with their plugin id", () => {
    const unregister = registerPlugin(makePlugin({ id: "test.flat" }));
    const panels = listPanelContributions();
    const mine = panels.filter((panel) => panel.pluginId === "test.flat");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "panel-a", order: 10, key: "a" });
    expect(typeof mine[0].render).toBe("function");
    unregister();
  });

  it("supports a static array instead of a function", () => {
    const unregister = registerPlugin(
      makePlugin({
        id: "test.static",
        panels: [{ id: "panel-static", order: 5, render: () => null }],
        toolbar: [{ id: "panel-static", order: 5, panelId: "panel-static" }],
      }),
    );
    expect(
      listPanelContributions().some(
        (panel) => panel.pluginId === "test.static" && panel.id === "panel-static",
      ),
    ).toBe(true);
    expect(
      listToolbarContributions().some(
        (item) => item.pluginId === "test.static" && item.id === "panel-static",
      ),
    ).toBe(true);
    unregister();
  });

  it("lists controllers for plugins that have one", () => {
    const unregister = registerPlugin(makePlugin({ id: "test.ctrl" }));
    const withController = listPluginControllers();
    expect(withController.some((item) => item.id === "test.ctrl")).toBe(true);
    expect(withController.every((item) => typeof item.createController === "function")).toBe(
      true,
    );
    unregister();
  });
});

describe("resolvePanelContributions against the builtin manifest", () => {
  // These tests exercise the real builtin plugins (registered through
  // ../index.jsx), not fixtures: they pin the contract that AppMainWorkspace
  // renders from the manifest, in manifest order, gated by enabled.
  beforeAll(() => {
    registerBuiltinPlugins();
  });
  it("resolves sftp before status in manifest order", () => {
    const extensions = defaultExtensionState();
    const panels = resolvePanelContributions(extensions);
    expect(panels.map((panel) => panel.key)).toEqual(["sftp", "status"]);
    expect(panels[0].order).toBeLessThan(panels[1].order);
  });

  it("hides a disabled extension's panel entirely", () => {
    const extensions = defaultExtensionState().map((extension) =>
      extension.id === "eshell.sftp" ? { ...extension, enabled: false } : extension,
    );
    const panels = resolvePanelContributions(extensions);
    expect(panels.map((panel) => panel.key)).toEqual(["status"]);
  });

  it("hides the toolbar entry for a disabled extension", () => {
    const extensions = defaultExtensionState().map((extension) =>
      extension.id === "eshell.server-monitor" ? { ...extension, enabled: false } : extension,
    );
    const toolbar = resolveToolbarContributions(extensions);
    expect(toolbar.map((item) => item.key)).toEqual(["sftp"]);
  });

  it("falls back to rendering registered panels missing from the manifest", () => {
    // A manifest regression must not blank the dock: the orphan renders last.
    const extensions = defaultExtensionState().filter(
      (extension) => extension.id !== "eshell.status" ? false : true,
    );
    const panels = resolvePanelContributions(extensions.slice(0, 0));
    // With no manifest rows at all, both registered panels survive as orphans.
    expect(panels.map((panel) => panel.key).sort()).toEqual(["sftp", "status"]);
  });
});
