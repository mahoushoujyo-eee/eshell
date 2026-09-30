/**
 * Status detail-tab switching on a real (fake-DOM) React root.
 *
 * The traffic block used to sit permanently under the resource bars; it now
 * lives behind the `Network` chip in the detail switcher, so the tab has to
 * actually render it — with the NIC selector and the totals line — and the
 * socket-free default view has to keep showing only processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke must not run in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { act } from "react";
import StatusPanel from "../status/StatusPanel";
import { installFakeDom, uninstallFakeDom, findElement, findElements } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";
import { STATUS_SNAPSHOT, formatBytes } from "../../test/workbench-fixtures.js";

const makeProps = (overrides = {}) => ({
  activeSessionId: "session-alpha",
  currentStatus: STATUS_SNAPSHOT,
  currentNic: "eth0",
  onNicChange: () => {},
  formatBytes,
  refreshInterval: 5000,
  onRefreshIntervalChange: () => {},
  ...overrides,
});

const findChip = (root, label) =>
  findElement(
    root,
    (node) =>
      node.tagName === "BUTTON" && (node.textContent ?? "").toString().trim().startsWith(label),
  );

const clickChip = (root, label) =>
  act(async () => {
    fireClick(findChip(root, label));
  });

beforeEach(() => {
  installFakeDom();
});

afterEach(() => {
  uninstallFakeDom();
});

describe("StatusPanel detail tabs", () => {
  it("keeps the traffic block out of the default processes view", async () => {
    const mounted = await render(createElement(StatusPanel, makeProps()));
    const text = () => mounted.container.textContent;

    expect(text()).toContain("node server.js");
    expect(text()).not.toContain("Total RX");

    await mounted.unmount();
  });

  it("renders the traffic block, NIC options, and totals on the Network tab", async () => {
    const mounted = await render(createElement(StatusPanel, makeProps()));
    const text = () => mounted.container.textContent;

    await clickChip(mounted.container, "Network");

    // The processes table gives way to the traffic block.
    expect(text()).not.toContain("node server.js");
    expect(text()).toContain("Total RX 1.0 KB / Total TX 512 B");
    expect(text()).toContain("0 B/s");

    // NIC options from the snapshot; eth0 selected. React lands the selection
    // on the option nodes, not on select.value.
    const select = findElement(mounted.container, (node) => node.tagName === "SELECT");
    expect(select).not.toBeNull();
    const options = Array.from(select.options);
    expect(options.map((option) => option.value)).toEqual(["eth0", "lo"]);
    expect(options.find((option) => option.selected)?.value).toBe("eth0");

    // Switching back returns to processes.
    await clickChip(mounted.container, "Processes");
    expect(text()).toContain("node server.js");
    expect(text()).not.toContain("Total RX");

    await mounted.unmount();
  });

  it("forwards NIC selection changes and stays on the Network tab", async () => {
    const onNicChange = vi.fn();
    const mounted = await render(createElement(StatusPanel, makeProps({ onNicChange })));

    await clickChip(mounted.container, "Network");
    const select = findElement(mounted.container, (node) => node.tagName === "SELECT");
    await act(async () => {
      select.value = "lo";
      select.dispatchEvent(
        new (globalThis.window.Event)("change", { target: select, bubbles: true }),
      );
    });

    expect(onNicChange).toHaveBeenCalledWith("lo");
    expect(findChip(mounted.container, "Network").getAttribute("aria-pressed")).toBe("true");
    // Only one select exists: the old resident copy is gone.
    expect(findElements(mounted.container, (node) => node.tagName === "SELECT")).toHaveLength(1);

    await mounted.unmount();
  });
});
