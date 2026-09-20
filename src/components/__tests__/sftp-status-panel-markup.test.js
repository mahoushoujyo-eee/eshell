/**
 * Pre-migration markup baseline for the SFTP and status panels.
 *
 * Rendered with react-dom/server (`renderToStaticMarkup`) in the node Vitest
 * environment — no DOM at all — pinning the static markup of the panel states
 * reachable without mounting:
 *   SFTP: connected toolbar + entries (sorted, dotfiles hidden) vs. the
 *         no-session state (tree prompt, disabled toolbar actions), and the
 *         transfer queue staying closed until opened.
 *   Status: the empty state, and full data with resource bars, the traffic
 *         block, NIC options, and the processes detail view (the default).
 *
 * Effects (tree loading, detail-view auto-switching) do not run on the
 * server, so disks/GPU views and open dialogs are not reachable here; those
 * are covered by the fake-DOM suites in this directory. The active-interval
 * markup uses the en-US i18n default, and `toLocaleTimeString("en-US")` is
 * ICU-stable, so the fetched-at chip is deterministic.
 *
 * Inline snapshots are the frozen baseline: captured from the pre-migration
 * components, they must keep matching after the UI migration.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke must not run in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

import * as ReactDOMServer from "react-dom/server";
import { createElement } from "react";
import SftpPanel from "../panels/SftpPanel";
import StatusPanel from "../panels/StatusPanel";
import {
  SFTP_ENTRIES,
  SFTP_TRANSFERS,
  STATUS_SNAPSHOT,
  formatBytes,
} from "../../test/workbench-fixtures.js";

const renderStatic = (element) => ReactDOMServer.renderToStaticMarkup(element);

const sftpNoop = async () => ({});
const makeSftpProps = (overrides = {}) => ({
  activeSessionId: "session-alpha",
  currentPath: "/var",
  requestSftpDir: sftpNoop,
  refreshSftp: sftpNoop,
  uploadFile: sftpNoop,
  createSftpEntry: sftpNoop,
  downloadFile: sftpNoop,
  deleteSftpEntry: sftpNoop,
  renameSftpEntry: sftpNoop,
  copySftpEntryPath: sftpNoop,
  cancelTransfer: () => {},
  downloadDirectory: "/home/user/downloads",
  onDownloadDirectoryChange: () => {},
  transfers: [],
  selectedEntry: null,
  sftpEntries: SFTP_ENTRIES,
  openEntry: sftpNoop,
  selectSftpEntry: () => {},
  onOpenFileEditor: () => {},
  formatBytes,
  ...overrides,
});

const makeStatusProps = (overrides = {}) => ({
  activeSessionId: "session-alpha",
  currentStatus: null,
  currentNic: null,
  onNicChange: () => {},
  formatBytes,
  refreshInterval: 5000,
  onRefreshIntervalChange: () => {},
  ...overrides,
});

describe("SftpPanel static markup (pre-migration baseline)", () => {
  it("renders the connected toolbar, root-only tree, and sorted entries", () => {
    const markup = renderStatic(createElement(SftpPanel, makeSftpProps()));
    expect(markup).toContain("SFTP Browser");
    expect(markup).toContain("Path: /var");
    expect(markup).toContain("app.log");
    expect(markup).toContain("4.0 KB");
    // Dotfiles stay hidden without the toggle.
    expect(markup).not.toContain(".env");
    // Tree loading is an effect; on the server only the root row renders.
    expect(markup).toContain('title="/"');
    expect(markup).not.toContain('title="/var/log"');
    // Directory rows show a dash instead of a size.
    expect(markup).toContain(">-<");
    expect(markup).toMatchSnapshot();
  });

  it("renders the no-session state with the SSH prompt and disabled actions", () => {
    const markup = renderStatic(
      createElement(SftpPanel, makeSftpProps({ activeSessionId: null, sftpEntries: [] })),
    );
    expect(markup).toContain("Connect SSH first");
    // Refresh / New / Upload / Download all disabled without a session.
    const disabledButtons = (markup.match(/disabled=""/g) || []).length;
    expect(disabledButtons).toBe(4);
    expect(markup).toMatchSnapshot();
  });

  it("keeps the transfer queue closed until it is toggled open", () => {
    const markup = renderStatic(
      createElement(SftpPanel, makeSftpProps({ transfers: SFTP_TRANSFERS })),
    );
    expect(markup).not.toContain("Transfer Queue");
    expect(markup).not.toContain("dump.sql");
    expect(markup).not.toContain("Download Dir:");
    expect(markup).toMatchSnapshot();
  });

  it("enables the download action only for a selected file entry", () => {
    const fileEntry = SFTP_ENTRIES.find((entry) => entry.entryType === "file");
    const directoryEntry = SFTP_ENTRIES.find((entry) => entry.entryType === "directory");

    const noneSelected = renderStatic(createElement(SftpPanel, makeSftpProps()));
    const fileSelected = renderStatic(
      createElement(SftpPanel, makeSftpProps({ selectedEntry: fileEntry })),
    );
    const directorySelected = renderStatic(
      createElement(SftpPanel, makeSftpProps({ selectedEntry: directoryEntry })),
    );

    const disabledCount = (markup) => (markup.match(/disabled=""/g) || []).length;
    expect(disabledCount(noneSelected)).toBe(1); // download only (session active)
    expect(disabledCount(fileSelected)).toBe(0);
    expect(disabledCount(directorySelected)).toBe(1);
    expect(noneSelected).toMatchSnapshot();
    expect(fileSelected).toMatchSnapshot();
    expect(directorySelected).toMatchSnapshot();
  });
});

describe("StatusPanel static markup (pre-migration baseline)", () => {
  it("renders the empty state with the default 5s interval active", () => {
    const markup = renderStatic(createElement(StatusPanel, makeStatusProps()));
    expect(markup).toContain("Server Status");
    expect(markup).toContain("No status data");
    expect(markup).toContain("1s");
    expect(markup).toContain("10s");
    expect(markup).toContain('title="Refresh every 5s">5s');
    // 5s is the active interval: accent background, white text.
    expect(markup).toContain('bg-accent text-white" title="Refresh every 5s">5s');
    expect(markup).toMatchSnapshot();
  });

  it("renders resource bars, traffic, NIC options, and the processes view", () => {
    const markup = renderStatic(
      createElement(StatusPanel, makeStatusProps({ currentStatus: STATUS_SNAPSHOT, currentNic: "eth0" })),
    );
    expect(markup).toContain("12.50%");
    expect(markup).toContain("2.00 / 8.00 GB");
    expect(markup).toContain("node server.js");
    expect(markup).toContain("128.0 MB");
    expect(markup).toContain("0.1%");
    // NIC options from the snapshot; eth0 selected.
    expect(markup).toContain('<option value="eth0" selected="">eth0</option>');
    expect(markup).toContain('<option value="lo">lo</option>');
    expect(markup).toContain('selected=""');
    // Traffic totals and the en-US fetched-at chip.
    expect(markup).toContain("Total RX 1.0 KB / Total TX 512 B");
    expect(markup).toContain("4:00:00 PM");
    // Detail switcher chips carry the counts.
    expect(markup).toContain("Processes");
    expect(markup).toContain("Disks");
    expect(markup).toContain("GPU");
    expect(markup).toMatchSnapshot();
  });

  it("renders the processes view empty message when no process data exists", () => {
    const markup = renderStatic(
      createElement(
        StatusPanel,
        makeStatusProps({
          currentStatus: { ...STATUS_SNAPSHOT, topProcesses: [], disks: [], gpus: [] },
        }),
      ),
    );
    expect(markup).toContain("No process data");
    expect(markup).not.toContain("No status data");
    expect(markup).toMatchSnapshot();
  });

});
