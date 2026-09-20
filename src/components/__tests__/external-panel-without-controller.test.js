import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { render } from "../../test/react-render.js";
import ExternalPanelHost from "../../plugins/runtime/ExternalPanelHost.jsx";
import { getControllerStore, getOrCreateControllerStore } from "../../plugins/runtime/controllerStore";

let mounted;
beforeEach(() => installFakeDom());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  uninstallFakeDom();
});

describe("external panels with an optional controller", () => {
  it("renders a plain panel immediately without creating or waiting for a controller store", async () => {
    const plugin = { id: "com.example.plain", builtin: false, api: { meta: { apiVersion: 1 } } };
    const renderPanel = vi.fn(({ controller }) => createElement("p", null, `plain ${Object.keys(controller).length}`));
    mounted = await render(createElement(ExternalPanelHost, {
      plugin,
      panel: { id: "plain.panel", title: "Plain", render: renderPanel },
    }));
    expect(mounted.container.textContent).toBe("plain 0");
    expect(renderPanel).toHaveBeenCalledWith(expect.objectContaining({ api: plugin.api, controller: {} }));
    expect(getControllerStore(plugin)).toBeFalsy();
  });

  it("still waits for the first snapshot when a controller was actually registered", async () => {
    const plugin = { id: "com.example.controlled", builtin: false, api: {}, createController: () => ({ text: "ready" }) };
    const renderPanel = vi.fn(({ controller }) => createElement("p", null, controller.text));
    mounted = await render(createElement(ExternalPanelHost, {
      plugin,
      panel: { id: "controlled.panel", render: renderPanel },
    }));
    expect(renderPanel).not.toHaveBeenCalled();
    await act(async () => { getOrCreateControllerStore(plugin).publish({ text: "ready" }); });
    expect(mounted.container.textContent).toBe("ready");
  });
});
