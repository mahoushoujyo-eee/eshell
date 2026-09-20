/**
 * Pre-migration baseline for KeepAlive's core promise: panel trees never
 * unmount, so panel-local state (open dotfile filter, drafts, scroll) survives
 * hiding and re-showing a panel, and the host node physically moves between
 * the layout slot and a `display: none` stash under document.body.
 *
 * Kept in its own file: the multi-rerender sequences here are sensitive to
 * leftover scheduler state from unrelated suites in the same worker.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke must not run in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
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

import { act } from "react";
import { createElement } from "react";
import {
  findElement,
  findElements,
  installFakeDom,
  uninstallFakeDom,
} from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";
import { makeAcp, makeUi, makeWorkbench } from "../../test/workbench-fixtures.js";

// The migrated AppMainWorkspace resolves sftp/status panels from the plugin
// registry; the app root registers the builtin plugins exactly once. Tests
// do the same before rendering (idempotent).
import { registerBuiltinPlugins } from "../../plugins/index.jsx";
registerBuiltinPlugins();


/** Occupied display:none stash containers directly under document.body. */
function stashContainers(document) {
  return document.body.childNodes.filter(
    (node) =>
      node.nodeType === 1 &&
      node !== document.body &&
      node.style.getPropertyValue("display") === "none" &&
      node.parentNode === document.body &&
      node.childNodes.length > 0,
  );
}

/**
 * The KeepAlive *host* div for a panel: the `h-full w-full` div that is the
 * direct parent of the panel's own root element. Identified by the panel's
 * marker text (the terminal pane is also `bg-panel`, so class alone is not
 * enough) and then walking one level up to the host.
 */
function keepAliveHostFor(root, marker) {
  const panelRoot = findElement(
    root,
    (node) =>
      node.nodeType === 1 &&
      node.getAttribute("class")?.includes("bg-panel") &&
      node.textContent.includes(marker),
  );
  if (!panelRoot) return null;
  const host = panelRoot.parentNode;
  return host && host.className === "h-full w-full" ? host : null;
}

describe("KeepAlive state preservation across visibility toggles (pre-migration baseline)", () => {
  it("moves hosts between layout and stash without losing panel-local state", async () => {
    installFakeDom();
    try {
      const AppMainWorkspace = (
        await import("../app/AppMainWorkspace.jsx")
      ).default;
      const buildElement = (visibility) =>
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(visibility),
          acp: makeAcp(),
          ...visibility,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        });

      // SFTP visible alone.
      const mounted = await render(
        buildElement({ showSftpPanel: true, showStatusPanel: false, showCommandDraftPanel: false }),
      );
      const sftpHost = keepAliveHostFor(mounted.container, "SFTP Browser");
      expect(sftpHost).not.toBeNull();
      expect(sftpHost.className).toBe("h-full w-full");
      expect(sftpHost.style.getPropertyValue("display")).not.toBe("none");

      // Flip a panel-local toggle (show dotfiles) inside SFTP.
      const showHiddenButton = findElement(
        mounted.container,
        (node) => node.getAttribute("title") === "Show dotfiles",
      );
      expect(showHiddenButton).not.toBeNull();
      await act(async () => {
        fireClick(showHiddenButton);
      });
      expect(mounted.container.textContent.includes(".env")).toBe(true);

      // Two visible panels: sftp host still the same node, status joins.
      await mounted.rerender(
        buildElement({ showSftpPanel: true, showStatusPanel: true, showCommandDraftPanel: false }),
      );
      expect(keepAliveHostFor(mounted.container, "SFTP Browser")).toBe(sftpHost);

      // Hide sftp: host node detaches into a stash under body.
      await mounted.rerender(
        buildElement({ showSftpPanel: false, showStatusPanel: true, showCommandDraftPanel: false }),
      );
      expect(mounted.container.textContent.includes("SFTP Browser")).toBe(false);
      const stashes = stashContainers(globalThis.document);
      expect(stashes.length).toBe(2); // sftp + draft (draft hidden from the start)
      const sftpStash = stashes.find((stash) =>
        stash.firstChild.textContent.includes("SFTP Browser"),
      );
      expect(sftpStash).toBeTruthy();
      expect(sftpStash.firstChild).toBe(sftpHost); // the very same node
      expect(sftpHost.style.getPropertyValue("display")).toBe("none");

      // Re-show sftp: same host node returns to the layout with its state.
      await mounted.rerender(
        buildElement({ showSftpPanel: true, showStatusPanel: true, showCommandDraftPanel: false }),
      );
      const sftpHostAgain = keepAliveHostFor(mounted.container, "SFTP Browser");
      expect(sftpHostAgain).toBe(sftpHost);
      expect(sftpHost.style.getPropertyValue("display")).not.toBe("none");
      expect(sftpHost.textContent.includes(".env")).toBe(true);

      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });

  it("collapses the bottom splitter when the last panel is dismissed", async () => {
    installFakeDom();
    try {
      const AppMainWorkspace = (
        await import("../app/AppMainWorkspace.jsx")
      ).default;
      const buildElement = (visibility) =>
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(visibility),
          acp: makeAcp(),
          ...visibility,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        });

      const mounted = await render(
        buildElement({ showSftpPanel: false, showStatusPanel: true, showCommandDraftPanel: false }),
      );
      const rowsButtons = () =>
        findElements(
          mounted.container,
          (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize rows",
        );
      expect(rowsButtons().length).toBe(1);
      expect(rowsButtons()[0].getAttribute("class")).not.toContain("pointer-events-none");

      await mounted.rerender(
        buildElement({ showSftpPanel: false, showStatusPanel: false, showCommandDraftPanel: false }),
      );
      expect(rowsButtons()[0].getAttribute("class")).toContain("pointer-events-none");
      expect(rowsButtons()[0].getAttribute("class")).toContain("opacity-0");

      // The bottom section keeps rendering but holds no slot wrapper.
      const section = findElement(
        mounted.container,
        (node) => node.nodeName === "SECTION" && node.className === "h-full",
      );
      expect(section).not.toBeNull();
      expect(section.childNodes.length).toBe(0);

      // Panel trees still exist, all three stashed.
      expect(stashContainers(globalThis.document).length).toBe(3);

      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });
});
