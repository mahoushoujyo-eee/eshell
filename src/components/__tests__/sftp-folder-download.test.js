/**
 * Folder download is not supported by the backend: it transfers one remote
 * file per request, so a folder request can only fail with an opaque IO
 * error. The panel therefore answers it with a popup.
 *
 * The same toolbar button used to hand its click event to the download
 * operation, which read it as a remote entry and downloaded the remote root
 * ("/") instead of the selected file. Both behaviours are pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

import { act, createElement } from "react";
import { findElement, installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";
import { SFTP_ENTRIES, formatBytes } from "../../test/workbench-fixtures.js";
import SftpPanel from "../panels/SftpPanel";

const downloadFile = vi.fn(async () => {});
const openEntry = vi.fn(async () => ({ opened: false }));

const makeProps = (overrides = {}) => ({
  activeSessionId: "session-alpha",
  currentPath: "/var",
  requestSftpDir: vi.fn(async (path) => ({ path, entries: SFTP_ENTRIES })),
  refreshSftp: vi.fn(async (path) => ({ path, entries: SFTP_ENTRIES })),
  uploadFile: vi.fn(async () => {}),
  createSftpEntry: vi.fn(async () => true),
  downloadFile,
  deleteSftpEntry: vi.fn(async () => true),
  renameSftpEntry: vi.fn(async () => true),
  copySftpEntryPath: vi.fn(async () => true),
  cancelTransfer: () => {},
  downloadDirectory: "/home/user/downloads",
  onDownloadDirectoryChange: () => {},
  transfers: [],
  selectedEntry: null,
  sftpEntries: SFTP_ENTRIES,
  openEntry,
  selectSftpEntry: () => {},
  onOpenFileEditor: () => {},
  formatBytes,
  ...overrides,
});

const downloadButton = (root) =>
  findElement(
    root,
    (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Download",
  );

const dialogOf = (root) =>
  findElement(root, (node) => node.nodeName === "DIV" && node.getAttribute("role") === "dialog");

const buttonByText = (root, text) =>
  findElement(root, (node) => node.nodeName === "BUTTON" && node.textContent.trim() === text);

const fileEntry = SFTP_ENTRIES.find((entry) => entry.entryType === "file");
const directoryEntry = SFTP_ENTRIES.find((entry) => entry.entryType === "directory");

describe("SFTP folder download restriction", () => {
  beforeEach(() => {
    installFakeDom();
    downloadFile.mockClear();
    openEntry.mockClear();
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("downloads the selected file instead of the remote root", async () => {
    const mounted = await render(
      createElement(SftpPanel, makeProps({ selectedEntry: fileEntry })),
    );

    await act(async () => {
      fireClick(downloadButton(mounted.container));
    });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(downloadFile.mock.calls[0][0]).toBe(fileEntry);
    expect(downloadFile.mock.calls[0][0].path).toBe("/var/app.log");
    expect(dialogOf(mounted.container)).toBeNull();

    await mounted.unmount();
  });

  it("explains that a folder cannot be downloaded and starts no transfer", async () => {
    const mounted = await render(
      createElement(SftpPanel, makeProps({ selectedEntry: directoryEntry })),
    );

    await act(async () => {
      fireClick(downloadButton(mounted.container));
    });

    expect(downloadFile).not.toHaveBeenCalled();

    const dialog = dialogOf(mounted.container);
    expect(dialog, "the folder download popup must open").toBeTruthy();
    expect(dialog.textContent).toContain("Folder download is not supported");
    expect(dialog.textContent).toContain("log");
    expect(dialog.textContent).toContain("/var/log");

    await mounted.unmount();
  });

  it("opens the folder from the popup and closes it", async () => {
    const mounted = await render(
      createElement(SftpPanel, makeProps({ selectedEntry: directoryEntry })),
    );

    await act(async () => {
      fireClick(downloadButton(mounted.container));
    });
    expect(dialogOf(mounted.container)).toBeTruthy();

    await act(async () => {
      fireClick(buttonByText(mounted.container, "Open Folder"));
    });

    expect(openEntry).toHaveBeenCalledTimes(1);
    expect(openEntry.mock.calls[0][0].path).toBe("/var/log");
    expect(dialogOf(mounted.container)).toBeNull();

    await mounted.unmount();
  });

  it("closes the popup without a transfer", async () => {
    const mounted = await render(
      createElement(SftpPanel, makeProps({ selectedEntry: directoryEntry })),
    );

    await act(async () => {
      fireClick(downloadButton(mounted.container));
    });
    await act(async () => {
      fireClick(buttonByText(mounted.container, "OK"));
    });

    expect(downloadFile).not.toHaveBeenCalled();
    expect(dialogOf(mounted.container)).toBeNull();

    await mounted.unmount();
  });
});
