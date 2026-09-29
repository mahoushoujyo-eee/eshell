/**
 * Settings → File Editor: the auto-sync switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { act } from "react";
import SettingsModal from "../sidebar/SettingsModal.jsx";
import { I18nProvider } from "../../lib/i18n.js";
import { installFakeDom, uninstallFakeDom, findElement } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";

const textOf = (node) => (node?.textContent ?? "").toString();
const findSwitch = (root) => findElement(root, (node) => node.getAttribute?.("role") === "switch");

async function openFileEditorTab(props) {
  const mounted = await render(
    createElement(
      I18nProvider,
      null,
      createElement(SettingsModal, {
        open: true,
        onClose: () => {},
        theme: "light",
        onSelectTheme: () => {},
        wallpaperLabel: "none",
        onOpenWallpaperPicker: () => {},
        ...props,
      }),
    ),
  );
  const navItem = findElement(
    mounted.container,
    (node) => node.tagName === "BUTTON" && textOf(node).trim() === "File Editor",
  );
  await act(async () => {
    fireClick(navItem);
  });
  return mounted;
}

describe("Settings File Editor tab", () => {
  beforeEach(() => {
    installFakeDom();
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("shows auto sync off and explains what turning it on does", async () => {
    const mounted = await openFileEditorTab({ fileAutoSync: false, onFileAutoSyncChange: vi.fn() });

    expect(findSwitch(mounted.container).getAttribute("aria-checked")).toBe("false");
    expect(textOf(mounted.container)).toContain("When on, edited files are saved automatically.");

    await mounted.unmount();
  });

  it("turns auto sync on from the switch", async () => {
    const onFileAutoSyncChange = vi.fn();
    const mounted = await openFileEditorTab({ fileAutoSync: false, onFileAutoSyncChange });

    await fireClick(findSwitch(mounted.container));

    expect(onFileAutoSyncChange).toHaveBeenCalledWith(true);
    await mounted.unmount();
  });

  it("turns auto sync off from the switch", async () => {
    const onFileAutoSyncChange = vi.fn();
    const mounted = await openFileEditorTab({ fileAutoSync: true, onFileAutoSyncChange });

    expect(findSwitch(mounted.container).getAttribute("aria-checked")).toBe("true");
    await fireClick(findSwitch(mounted.container));

    expect(onFileAutoSyncChange).toHaveBeenCalledWith(false);
    await mounted.unmount();
  });
});
