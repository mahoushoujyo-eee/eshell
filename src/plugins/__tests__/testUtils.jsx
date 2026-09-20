// Minimal renderHook for plugin controller tests. Runs a real React root on a
// fake-DOM container under act, so effects fire exactly as in the app.
//
// The fake DOM comes from the shared test helpers in `src/test/` (installed
// with installFakeDom()); this file only adds the hook-rendering part.
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

export async function renderHook(callback) {
  if (typeof globalThis.document === "undefined") {
    throw new Error("renderHook requires the fake DOM; call installFakeDom() first.");
  }
  let latest;
  const current = {};
  const container = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const Probe = () => {
    latest = callback(current);
    return null;
  };
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    get current() {
      return latest;
    },
    async rerender() {
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    unmount() {
      return act(async () => {
        root.unmount();
      });
    },
  };
}
