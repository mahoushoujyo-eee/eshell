import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { activate } from "../../../examples/hello-plugin/index.js";
import manifest from "../../../examples/hello-plugin/manifest.json";

function fixture() {
  const values = new Map();
  const panels = [];
  const toolbars = [];
  let controller;
  const disposers = [];
  const register = (accept) => vi.fn((item) => {
    accept(item);
    const dispose = vi.fn();
    disposers.push(dispose);
    return dispose;
  });
  const api = {
    react: React,
    meta: { pluginId: manifest.id, apiVersion: 1 },
    sessions: { list: vi.fn(async () => [{ id: "example-session" }]) },
    storage: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
    ui: {
      registerPanel: register((panel) => panels.push(panel)),
      registerToolbar: register((toolbar) => toolbars.push(toolbar)),
      registerController: register((hook) => { controller = hook; }),
    },
    log: { info: vi.fn() },
  };
  return {
    api, values, panels, toolbars, disposers,
    render() {
      function Host() {
        const state = controller({ api, activeSessionId: "example-session" });
        return panels.at(-1).render({
          api,
          context: { activeSessionId: "example-session" },
          controller: state,
        });
      }
      return renderToStaticMarkup(React.createElement(Host));
    },
  };
}

describe("ready-to-load hello plugin example", () => {
  it("activates real ESM with the host React API and registers matching contributions", async () => {
    const host = fixture();
    const dispose = await activate(host.api);
    expect(manifest.builtin).toBe(false);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.main).toBe("index.js");
    expect(host.panels[0].id).toBe(manifest.contributes.panels[0].id);
    // The example opts in explicitly, so it is visible right after install.
    expect(host.panels[0].defaultVisible).toBe(true);
    expect(host.toolbars[0].panelId).toBe(host.panels[0].id);
    expect(host.api.sessions.list).toHaveBeenCalledOnce();
    expect(host.values.get("activations")).toBe(1);

    const html = host.render();
    expect(html).toContain("Hello Plugin");
    expect(html).toContain("external ESM plugin through API v1");
    expect(html).toContain("Sessions at activation: 1");
    expect(html).toContain("Current session: example-session");
    expect(html).toContain("Clicks: 0");
    dispose();
    for (const unregister of host.disposers) expect(unregister).toHaveBeenCalledOnce();
  });

  it("reads persisted values when activated again", async () => {
    const host = fixture();
    const dispose = await activate(host.api);
    dispose();
    host.values.set("clicks", 7);
    const nextDispose = await activate(host.api);
    expect(host.values.get("activations")).toBe(2);
    expect(host.render()).toContain("Clicks: 7");
    nextDispose();
  });
});
