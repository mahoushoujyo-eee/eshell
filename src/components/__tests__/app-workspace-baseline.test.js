/**
 * Pre-migration baseline for the bottom-panel workspace layout.
 *
 * These tests pin the observable structure `AppMainWorkspace` produces with
 * `KeepAlive` + `SplitPane`:
 *   - every panel tree stays mounted (portaled into a KeepAlive host div),
 *     whether visible or hidden;
 *   - hidden panel hosts are parked in a `display: none` stash container
 *     appended to `document.body`;
 *   - visible panel hosts sit in the layout in the order the bottom panels
 *     are declared (sftp, status, draft), wrapped by the splitter structure
 *     for 1 / 2 / 3 visible panels.
 *
 * Scope: structural and lifecycle assertions on a real React 19 client root
 * over the fake DOM in `src/test/fake-dom.js` — not real-browser layout,
 * paint, or default actions; those are verified visually elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { createElement } from "react";
import {
  findElement,
  findElements,
  installFakeDom,
  serializeOutline,
  uninstallFakeDom,
} from "../../test/fake-dom.js";
import { render } from "../../test/react-render.js";
import { makeAcp, makeUi, makeWorkbench } from "../../test/workbench-fixtures.js";

// The migrated AppMainWorkspace resolves sftp/status panels from the plugin
// registry; the app root registers the builtin plugins exactly once. Tests
// do the same before rendering (idempotent).
import { registerBuiltinPlugins } from "../../plugins/index.jsx";
registerBuiltinPlugins();


let AppMainWorkspace;

beforeEach(async () => {
  ({ default: AppMainWorkspace } = await import("../app/AppMainWorkspace.jsx"));
});

/**
 * Stash containers that currently hold a panel host. KeepAlive creates one
 * `display: none` div per panel and keeps it attached to document.body for
 * the component's lifetime; emptying it means the panel moved back into the
 * layout. Only occupied stashes count, so an emptied stash from an earlier
 * visibility change does not double-count.
 */
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
 * The KeepAlive host chain for a panel: a `h-full w-full` div whose text
 * includes `marker`. Distinguishes wrapper/slot/host by looking from the
 * panel content upward.
 */
function hostDivFor(root, marker) {
  return findElement(root, (node) => node.className === "h-full w-full" && node.textContent.includes(marker));
}

function orderIndexOf(root, target) {
  let index = 0;
  let found = -1;
  const walk = (node) => {
    if (found >= 0) return;
    if (node === target) {
      found = index;
      return;
    }
    index += 1;
    (node.childNodes || []).forEach(walk);
  };
  walk(root);
  return found;
}

const precedes = (root, first, second) => orderIndexOf(root, first) < orderIndexOf(root, second);

describe("AppMainWorkspace bottom panel layout (pre-migration baseline)", () => {
  it("keeps all three panel trees mounted when every panel is hidden", async () => {
    const { document } = installFakeDom();
    try {
      const mounted = await render(
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(),
          acp: makeAcp(),
          showSftpPanel: false,
          showStatusPanel: false,
          showCommandDraftPanel: false,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );

      // 1. All three panel bodies exist somewhere in the document.
      expect(document.body.textContent).toContain("SFTP Browser");
      expect(document.body.textContent).toContain("Server Status");
      expect(document.body.textContent).toContain("Command Draft");

      // 2. None of them is inside the rendered layout container.
      expect(mounted.container.textContent.includes("SFTP Browser")).toBe(false);
      expect(mounted.container.textContent.includes("Server Status")).toBe(false);
      expect(mounted.container.textContent.includes("Command Draft")).toBe(false);

      // 3. Each hidden panel lives in its own display:none stash under body,
      //    and each stash holds exactly the panel's KeepAlive host div.
      const stashes = stashContainers(document);
      expect(stashes.length).toBe(3);
      const stashMarkers = stashes.map((stash) => {
        expect(stash.childNodes.length).toBe(1);
        const host = stash.firstChild;
        expect(host.className).toBe("h-full w-full");
        expect(host.style.getPropertyValue("display")).toBe("none");
        return host.textContent.slice(0, 40);
      });
      expect(stashMarkers.some((text) => text.includes("SFTP Browser"))).toBe(true);
      expect(stashMarkers.some((text) => text.includes("Server Status"))).toBe(true);
      expect(stashMarkers.some((text) => text.includes("Command Draft"))).toBe(true);

      // 4. The terminal still renders and the bottom area collapses.
      expect(mounted.container.textContent).toContain("prod-box");
      const rowsButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize rows",
      );
      expect(rowsButtons.length).toBe(1);
      expect(rowsButtons[0].getAttribute("class")).toContain("pointer-events-none");
      expect(rowsButtons[0].getAttribute("class")).toContain("opacity-0");

      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });

  it("places the single visible panel inside the layout without a bottom splitter", async () => {
    installFakeDom();
    try {
      const mounted = await render(
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench({ currentStatus: null }),
          acp: makeAcp(),
          showSftpPanel: false,
          showStatusPanel: true,
          showCommandDraftPanel: false,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );

      // Status panel content sits in the layout now.
      expect(mounted.container.textContent).toContain("Server Status");

      // The bottom area is: section.h-full > wrapper div > slot div > host.
      const section = findElement(
        mounted.container,
        (node) => node.nodeName === "SECTION" && node.className === "h-full",
      );
      expect(section).not.toBeNull();
      const wrapper = section.firstChild;
      expect(wrapper.className).toBe("h-full w-full");
      const slot = wrapper.firstChild;
      expect(slot.className).toBe("h-full w-full");
      const host = slot.firstChild;
      expect(host.className).toBe("h-full w-full");
      expect(host.style.getPropertyValue("display")).toBe("");
      expect(slot.style.getPropertyValue("display")).toBe("");

      // Exactly one terminal/status vertical splitter; no column splitter in
      // the bottom area (SFTP is hidden, so its internal splitter is stashed
      // away from the layout container).
      const columnButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize columns",
      );
      expect(columnButtons.length).toBe(0);
      const rowsButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize rows",
      );
      expect(rowsButtons.length).toBe(1);
      expect(rowsButtons[0].getAttribute("class")).not.toContain("pointer-events-none");

      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });

  it("splits two visible panels with sftp left of status", async () => {
    installFakeDom();
    try {
      const mounted = await render(
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(),
          acp: makeAcp(),
          showSftpPanel: true,
          showStatusPanel: true,
          showCommandDraftPanel: false,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );

      // Two bottom panels: the bottom-area splitter plus SFTP's internal
      // tree/entries splitter, and the terminal rows splitter.
      const columnButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize columns",
      );
      const rowsButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize rows",
      );
      expect(columnButtons.length).toBe(2);
      expect(rowsButtons.length).toBe(1);

      const sftpHost = hostDivFor(mounted.container, "SFTP Browser");
      const statusHost = hostDivFor(mounted.container, "Server Status");
      expect(sftpHost).not.toBeNull();
      expect(statusHost).not.toBeNull();
      expect(precedes(mounted.container, sftpHost, statusHost)).toBe(true);

      // Bottom-area splitter sits between the two panel hosts, after SFTP's
      // internal splitter (which lives inside the sftp host).
      const bottomSplitter = columnButtons.find(
        (button) => precedes(mounted.container, sftpHost, button) && precedes(mounted.container, button, statusHost),
      );
      expect(bottomSplitter).toBeTruthy();

      // Draft panel is hidden but still mounted, in a stash under body.
      expect(mounted.container.textContent.includes("Command Draft")).toBe(false);
      expect(globalThis.document.body.textContent).toContain("Command Draft");

      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });

  it("nests three visible panels sftp | status | draft left to right", async () => {
    installFakeDom();
    try {
      const mounted = await render(
        createElement(AppMainWorkspace, {
          workbench: makeWorkbench(),
          acp: makeAcp(),
          showSftpPanel: true,
          showStatusPanel: true,
          showCommandDraftPanel: true,
          onOpenFileEditor: makeUi().onOpenFileEditor,
        }),
      );

      // 3 column splitters: SFTP internal, sftp|status+draft, status|draft.
      const columnButtons = findElements(
        mounted.container,
        (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Resize columns",
      );
      expect(columnButtons.length).toBe(3);

      const sftpHost = hostDivFor(mounted.container, "SFTP Browser");
      const statusHost = hostDivFor(mounted.container, "Server Status");
      const draftHost = hostDivFor(mounted.container, "Command Draft");
      expect(precedes(mounted.container, sftpHost, statusHost)).toBe(true);
      expect(precedes(mounted.container, statusHost, draftHost)).toBe(true);

      // The two bottom-area splitters separate the three hosts pairwise.
      const firstSplitter = columnButtons.find(
        (button) => precedes(mounted.container, sftpHost, button) && precedes(mounted.container, button, statusHost),
      );
      const secondSplitter = columnButtons.find(
        (button) => precedes(mounted.container, statusHost, button) && precedes(mounted.container, button, draftHost),
      );
      expect(firstSplitter).toBeTruthy();
      expect(secondSplitter).toBeTruthy();
      expect(precedes(mounted.container, firstSplitter, secondSplitter)).toBe(true);

      // Nothing is stashed: every panel host is inside the layout.
      expect(stashContainers(globalThis.document).length).toBe(0);

      // Snapshot the bottom section's structural outline (nesting, split
      // structure, classes, layout-critical inline styles).
      const section = findElement(
        mounted.container,
        (node) => node.nodeName === "SECTION" && node.className === "h-full",
      );
      expect(serializeOutline(section)).toMatchSnapshot();

      await mounted.unmount();
    } finally {
      uninstallFakeDom();
    }
  });

});
