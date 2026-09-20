/**
 * React render helper for the fake DOM in `./fake-dom.js`.
 *
 * Mounts a real React 19 client root on a fake-DOM container under `act`,
 * so effects, portals, layout effects, and click handlers run the way they
 * do in the app. Scope matches fake-dom.js: structure and lifecycle
 * assertions, not real-browser layout or default actions.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FakeEvent } from "./fake-dom.js";

export async function render(element) {
  if (typeof globalThis.document === "undefined") {
    throw new Error("render() requires the fake DOM; call installFakeDom() first.");
  }
  const container = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    root,
    async rerender(next) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Dispatch a click on a fake-DOM node through React's delegated events. */
export function fireClick(node, init = {}) {
  return node.dispatchEvent(new FakeEvent("click", { target: node, ...init }));
}
