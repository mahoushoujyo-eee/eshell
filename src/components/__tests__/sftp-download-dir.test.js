/**
 * The transfer queue's "Change" button picks a new download directory.
 *
 * The builtin SFTP panel opens the picker through its plugin API
 * (`api.sftp.selectDownloadDir`), so the workspace must hand the panel that
 * API. Without it the call short-circuits on `api?.sftp` and the button
 * silently does nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeXterm {
    cols = 80;
    rows = 24;
    options = {};
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

import { act, createElement } from "react";
import { findElement, installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";
import { makeAcp, makeUi, makeWorkbench } from "../../test/workbench-fixtures.js";
import { registerBuiltinPlugins } from "../../plugins/index.jsx";
import AppMainWorkspace from "../app/AppMainWorkspace.jsx";

registerBuiltinPlugins();

const buttonByText = (root, text) =>
  findElement(root, (node) => node.nodeName === "BUTTON" && node.textContent.trim() === text);

describe("SFTP transfer queue download directory", () => {
  beforeEach(() => {
    installFakeDom();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "invoke_extension_api" && args?.input?.command === "select_download_dir") {
        return "D:\\Downloads\\picked";
      }
      return null;
    });
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("opens the picker through the plugin API and applies the chosen folder", async () => {
    const workbench = makeWorkbench();
    const mounted = await render(
      createElement(AppMainWorkspace, {
        workbench,
        acp: makeAcp(),
        showSftpPanel: true,
        showStatusPanel: false,
        showCommandDraftPanel: false,
        onOpenFileEditor: makeUi().onOpenFileEditor,
      }),
    );

    await act(async () => {
      fireClick(buttonByText(mounted.container, "Transfers"));
    });
    await act(async () => {
      fireClick(buttonByText(mounted.container, "Change"));
    });
    await act(async () => {});

    const pickerCall = invokeMock.mock.calls.find(
      ([command, args]) => command === "invoke_extension_api" && args?.input?.command === "select_download_dir",
    );
    expect(pickerCall, "the picker must go through the SFTP plugin's API").toBeTruthy();
    expect(pickerCall[1].input.extensionId).toBe("eshell.sftp");
    expect(pickerCall[1].input.args.defaultPath).toBe("/home/user/downloads");
    expect(workbench.handleDownloadDirectoryChange).toHaveBeenCalledWith("D:\\Downloads\\picked");

    await mounted.unmount();
  });
});
