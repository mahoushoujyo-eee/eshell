/**
 * The notice row is the panel's only error surface, so what it shows for
 * each code — and what it refuses to draw a card for — is worth pinning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import AcpNoticeRow from "../AcpNoticeRow.jsx";
import { I18nProvider } from "../../../../lib/i18n.js";
import { installFakeDom, uninstallFakeDom, findElement } from "../../../../test/fake-dom.js";
import { fireClick, render } from "../../../../test/react-render.js";

const textOf = (node) => (node?.textContent ?? "").toString();

const findButton = (root, label) =>
  findElement(
    root,
    (node) =>
      node.tagName === "BUTTON" &&
      (textOf(node).trim() === label || node.getAttribute?.("aria-label") === label),
  );

const mountNotice = (entry) =>
  render(createElement(I18nProvider, null, createElement(AcpNoticeRow, { entry })));

beforeEach(() => installFakeDom());
afterEach(() => {
  uninstallFakeDom();
  openUrl.mockReset();
});

describe("AcpNoticeRow", () => {
  it("splits a failure into a translated title and the raw detail", async () => {
    const { container, unmount } = await mountNotice({
      id: "n1",
      type: "notice",
      tone: "error",
      code: "start-failed",
      detail: "spawn npx ENOENT",
    });
    expect(textOf(container)).toContain("Failed to start agent");
    expect(textOf(container)).toContain("spawn npx ENOENT");
    await unmount();
  });

  it("collapses a long body behind Show details", async () => {
    const long = "x".repeat(400);
    const { container, unmount } = await mountNotice({
      id: "n2",
      type: "notice",
      tone: "error",
      code: "turn-failed",
      detail: long,
    });
    expect(textOf(container)).not.toContain(long);
    expect(findButton(container, "Show details")).toBeTruthy();
    await unmount();
  });

  it("expands the collapsed body on click", async () => {
    const long = "x".repeat(400);
    const { container, unmount } = await mountNotice({
      id: "n2b",
      type: "notice",
      tone: "error",
      code: "turn-failed",
      detail: long,
    });
    const more = findButton(container, "Show details");
    await act(async () => {
      fireClick(more);
    });
    expect(textOf(container)).toContain(long);
    await unmount();
  });

  it("renders a body-less non-error notice as a plain line, not a card", async () => {
    const { container, unmount } = await mountNotice({
      id: "n3",
      type: "notice",
      tone: "info",
      code: "session-ended",
      detail: "",
    });
    expect(findElement(container, (node) => node.getAttribute?.("role") === "status")).toBeNull();
    expect(textOf(container)).toContain("Session ended");
    await unmount();
  });

  it("offers the Node.js download instead of copy for env-missing", async () => {
    const { container, unmount } = await mountNotice({
      id: "n4",
      type: "notice",
      tone: "warning",
      code: "env-missing",
      detail: "node",
    });
    expect(findButton(container, "Get Node.js")).toBeTruthy();
    expect(findElement(container, (node) => node.getAttribute?.("aria-label") === "Copy")).toBeNull();
    await unmount();
  });

  it("opens the Node.js download page", async () => {
    const { container, unmount } = await mountNotice({
      id: "n5",
      type: "notice",
      tone: "warning",
      code: "env-missing",
      detail: "node",
    });
    const link = findButton(container, "Get Node.js");
    await act(async () => {
      fireClick(link);
    });
    expect(openUrl).toHaveBeenCalledWith("https://nodejs.org/");
    await unmount();
  });
});
