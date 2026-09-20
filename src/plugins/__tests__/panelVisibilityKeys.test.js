import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { registerPlugin } from "../registry";
import { usePanelVisibility } from "../runtime/usePanelVisibility";
import { renderHook } from "./testUtils.jsx";

let mounted;
let unregister;

beforeEach(() => {
  installFakeDom();
});

afterEach(async () => {
  await act(async () => { unregister?.(); });
  await mounted?.unmount();
  mounted = null;
  unregister = null;
  uninstallFakeDom();
});

function installPanel(key, defaultVisible) {
  const id = "com.example.visibility";
  unregister = registerPlugin({
    id,
    builtin: false,
    panels: () => [{ id: key, key, order: 30, defaultVisible, render: () => null }],
    toolbar: () => [],
  });
  return [{ id, builtin: false, enabled: true, contributes: { panels: [{ id: key, order: 30 }] } }];
}

describe("panel keys are identifiers, not Object prototype properties", () => {
  it.each(["constructor", "__proto__", "toString"])("applies defaults and toggles %s", async (key) => {
    const extensions = installPanel(key, true);
    mounted = await renderHook(() => usePanelVisibility(extensions));
    expect(mounted.current.isPanelVisible(key)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(mounted.current.visibility, key)).toBe(true);
    await act(async () => { mounted.current.togglePanel(key); });
    expect(mounted.current.isPanelVisible(key)).toBe(false);
    await act(async () => { mounted.current.togglePanel(key); });
    expect(mounted.current.isPanelVisible(key)).toBe(true);
  });

  it("opens an explicitly hidden inherited-name panel on the first toggle", async () => {
    const extensions = installPanel("constructor", false);
    mounted = await renderHook(() => usePanelVisibility(extensions));
    expect(mounted.current.isPanelVisible("constructor")).toBe(false);
    await act(async () => { mounted.current.togglePanel("constructor"); });
    expect(mounted.current.isPanelVisible("constructor")).toBe(true);
  });
});
