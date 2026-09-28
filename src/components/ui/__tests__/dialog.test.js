import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import Dialog from "../Dialog.jsx";
import { installFakeDom, uninstallFakeDom, findElement } from "../../../test/fake-dom.js";
import { render } from "../../../test/react-render.js";

const pressEscape = async () => {
  await act(async () => {
    globalThis.window.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  });
};

describe("Dialog", () => {
  beforeEach(() => {
    installFakeDom();
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("closes only the topmost dialog on Escape", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const mounted = await render(
      createElement(
        Dialog,
        { open: true, onClose: closeOuter, labelledBy: "outer" },
        createElement(Dialog, { open: true, onClose: closeInner, labelledBy: "inner" }),
      ),
    );

    await pressEscape();
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();

    await mounted.rerender(
      createElement(
        Dialog,
        { open: true, onClose: closeOuter, labelledBy: "outer" },
        createElement(Dialog, { open: false, onClose: closeInner, labelledBy: "inner" }),
      ),
    );
    await pressEscape();
    expect(closeOuter).toHaveBeenCalledTimes(1);

    await mounted.unmount();
  });

  it("ignores Escape while not dismissible, without passing it to the dialog below", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const mounted = await render(
      createElement(
        Dialog,
        { open: true, onClose: closeOuter },
        createElement(Dialog, { open: true, onClose: closeInner, dismissible: false }),
      ),
    );

    await pressEscape();
    expect(closeInner).not.toHaveBeenCalled();
    expect(closeOuter).not.toHaveBeenCalled();

    await mounted.unmount();
  });

  it("renders nothing when closed and a labelled modal panel when open", async () => {
    const mounted = await render(createElement(Dialog, { open: false, onClose() {} }, "body"));
    expect(mounted.container.textContent).toBe("");

    await mounted.rerender(createElement(Dialog, { open: true, onClose() {}, labelledBy: "title-id" }, "body"));
    const panel = findElement(mounted.container, (node) => node.getAttribute?.("role") === "dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe("title-id");
    expect(panel.textContent).toBe("body");

    await mounted.unmount();
  });
});
