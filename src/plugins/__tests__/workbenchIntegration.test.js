import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Controllable Tauri boundary. Each command routes to a handler the test
// installs; anything unmocked fails loudly instead of resolving undefined.
// ---------------------------------------------------------------------------
const commandHandlers = new Map();
const eventListeners = new Map();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    const handler = commandHandlers.get(command);
    if (!handler) {
      throw new Error(`unmocked command in test: ${command}`);
    }
    return handler(args ?? {});
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, handler) => {
    if (!eventListeners.has(name)) {
      eventListeners.set(name, new Set());
    }
    eventListeners.get(name).add(handler);
    return () => eventListeners.get(name)?.delete(handler);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { useWorkbench } from "../../hooks/useWorkbench";
import { I18nProvider } from "../../lib/i18n";

const fire = (name, payload) =>
  (eventListeners.get(name) || new Set()).forEach((handler) => handler({ payload }));

const listenerCount = (name) => eventListeners.get(name)?.size ?? 0;

// A plausible connected session, as `list_shell_sessions` returns it.
const SESSION = {
  id: "sess-alpha-001",
  configId: "cfg-1",
  configName: "prod-box",
  currentDir: "/var",
};

const STATUS = {
  cpuPercent: 12.5,
  memory: { usedMb: 2048, totalMb: 8192, usedPercent: 25 },
  disks: [],
  gpus: [],
  topProcesses: [],
  networkInterfaces: [{ interface: "eth0" }],
  selectedInterface: "eth0",
  selectedInterfaceTraffic: { interface: "eth0", rxBytes: 1024, txBytes: 512 },
  fetchedAt: "2026-09-18T08:00:00.000Z",
};

// Installs the command surface a connected session needs.
const installHappyCommands = () => {
  commandHandlers.set("list_ssh_configs", async () => []);
  commandHandlers.set("list_scripts", async () => []);
  commandHandlers.set("list_shell_sessions", async () => [SESSION]);
  commandHandlers.set("sftp_default_download_dir", async () => "/home/user/downloads");
  commandHandlers.set("list_extensions", async () => [
    {
      id: "eshell.sftp",
      displayName: "SFTP",
      version: "1.0.0",
      apiVersion: 1,
      builtin: true,
      defaultEnabled: true,
      enabled: true,
      contributes: { panels: [{ id: "sftp", order: 10 }] },
    },
    {
      id: "eshell.server-monitor",
      displayName: "Server Monitor",
      version: "1.0.0",
      apiVersion: 1,
      builtin: true,
      defaultEnabled: true,
      enabled: true,
      contributes: { panels: [{ id: "status", order: 20 }] },
    },
  ]);
  commandHandlers.set("sftp_list_dir", async () => ({
    path: "/var",
    entries: [
      { path: "/var/log", name: "log", entryType: "directory", size: 0, modifiedAt: 1700000000 },
      { path: "/var/app.log", name: "app.log", entryType: "file", size: 4096, modifiedAt: 1700000100 },
    ],
  }));
  commandHandlers.set("get_cached_server_status", async () => null);
  commandHandlers.set("fetch_server_status", async () => STATUS);
  commandHandlers.set("sftp_read_file", async () => ({
    path: "/var/app.log",
    content: "line one\n",
  }));
  commandHandlers.set("sftp_write_file", async () => null);
  // The migrated plugins broker every operation through invoke_extension_api
  // ({ extensionId, command, args}) with the existing Tauri argument shapes
  // (most commands: args = { input: {...} }; get_cached_server_status:
  // args = { sessionId }). The broker dispatches to the same command handlers
  // above by name, passing `args` through verbatim.
  commandHandlers.set("invoke_extension_api", async ({ input }) => {
    const { command, args } = input ?? {};
    const handler = commandHandlers.get(command);
    if (!handler) {
      throw new Error(`unbrokered command in test: ${command}`);
    }
    return handler(args);
  });
};

let mounted = null;

// Renders a probe that captures the full useWorkbench return value; the
// returned `wb` getter always reads the latest render's snapshot.
const renderWorkbench = async () => {
  const container = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(container);
  const root = createRoot(container);
  let latest = null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const Probe = () => {
    latest = useWorkbench();
    return null;
  };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(Probe)));
  });
  mounted = {
    root,
    get wb() {
      return latest;
    },
  };
  return mounted;
};

beforeEach(() => {
  installFakeDom();
  commandHandlers.clear();
  eventListeners.clear();
});

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted.root.unmount();
    });
    mounted = null;
  }
  commandHandlers.clear();
  eventListeners.clear();
  uninstallFakeDom();
});

describe("useWorkbench real composition: return keys", () => {
  it("exposes every HEAD return key, functions callable", async () => {
    installHappyCommands();
    const { wb } = await renderWorkbench();

    // Keys whose value may legitimately be null/undefined before the first
    // poll or file open — HEAD had the same shapes; presence is the contract.
    const nullable = new Set(["currentStatus", "currentNic", "selectedEntry", "hostKeyTrustPrompt", "kiPrompt"]);

    const expectedKeys = [
      "theme", "setTheme", "wallpaper", "setWallpaper",
      "showSftpPanel", "setShowSftpPanel",
      "showStatusPanel", "setShowStatusPanel",
      "showCommandDraftPanel", "setShowCommandDraftPanel",
      "statusRefreshInterval", "setStatusRefreshInterval",
      "showAiPanel", "setShowAiPanel",
      "busy", "error", "uiNotices", "dismissUiNotice",
      "hostKeyTrustPrompt", "resolveHostKeyTrust",
      "kiPrompt", "dismissKiPrompt",
      "sshConfigs", "sshForm", "setSshForm",
      "scripts", "scriptForm", "setScriptForm",
      "sessions", "activeSessionId", "setActiveSessionId", "activeSession",
      "commandDraft", "setCommandDraft",
      "downloadDirectory", "sftpTransfers", "currentPath",
      "currentStatus", "currentNic",
      "sftpEntries", "selectedEntry",
      "openFilePath", "dirtyFile", "openFileContent",
      "saveSsh", "connectServer", "cancelConnectServer",
      "closeSession", "reopenSessionPty",
      "disconnectedSessions",
      "sendCommandDraft", "sendPtyInput", "resizePty",
      "uploadFile", "createSftpEntry", "downloadFile",
      "deleteSftpEntry", "renameSftpEntry", "copySftpEntryPath",
      "cancelSftpTransfer",
      "saveScript", "runScript",
      "handleDeleteSsh", "handleDeleteScript",
      "handleNicChange", "handleOpenFileContentChange", "handleDownloadDirectoryChange",
      "requestSftpDir", "refreshSftp", "openEntry", "selectSftpEntry",
      "formatBytes",
    ];
    const missing = expectedKeys.filter(
      (key) => wb[key] === undefined && !nullable.has(key),
    );
    expect(missing).toEqual([]);
    // The nullable ones must still be *present* (the adapter did not drop them).
    const dropped = [...nullable].filter((key) => !(key in wb));
    expect(dropped).toEqual([]);

    const functionKeys = [
      "setTheme", "setWallpaper", "setShowSftpPanel", "setShowStatusPanel",
      "setShowCommandDraftPanel", "setStatusRefreshInterval", "setShowAiPanel",
      "dismissUiNotice", "resolveHostKeyTrust", "dismissKiPrompt",
      "setSshForm", "setScriptForm", "setActiveSessionId", "setCommandDraft",
      "saveSsh", "connectServer", "cancelConnectServer", "closeSession",
      "reopenSessionPty", "sendCommandDraft", "sendPtyInput", "resizePty",
      "uploadFile", "createSftpEntry", "downloadFile", "deleteSftpEntry",
      "renameSftpEntry", "copySftpEntryPath", "cancelSftpTransfer",
      "saveScript", "runScript", "handleDeleteSsh", "handleDeleteScript",
      "handleNicChange", "handleOpenFileContentChange", "handleDownloadDirectoryChange",
      "requestSftpDir", "refreshSftp", "openEntry", "selectSftpEntry",
      "formatBytes",
    ];
    const nonFunctions = functionKeys.filter((key) => typeof wb[key] !== "function");
    expect(nonFunctions).toEqual([]);
  });

  it("bootstraps the session and derives currentPath", async () => {
    installHappyCommands();
    const { wb } = await renderWorkbench();
    expect(wb.activeSessionId).toBe(SESSION.id);
    expect(wb.currentPath).toBe("/var");
    expect(wb.downloadDirectory).toBe("/home/user/downloads");
  });
});

describe("useWorkbench SFTP directory facade", () => {
  it("reads and refreshes directories through the injected API without hidden errors", async () => {
    installHappyCommands();
    const entries = [{ path: "/var/log/app.log", name: "app.log", entryType: "file", size: 12 }];
    const readDirectory = vi.fn(async ({ input }) => ({ path: input.path, entries }));
    commandHandlers.set("sftp_list_dir", readDirectory);
    const result = await renderWorkbench();

    await act(async () => {
      expect(await result.wb.requestSftpDir("/var/log")).toEqual({ path: "/var/log", entries });
      expect(await result.wb.refreshSftp("/var/log")).toEqual({ path: "/var/log", entries });
    });

    expect(readDirectory).toHaveBeenCalledWith({ input: { sessionId: SESSION.id, path: "/var/log" } });
    expect(result.wb.sftpEntries).toEqual(entries);
    expect(result.wb.currentPath).toBe("/var/log");
    expect(result.wb.error).toBe("");
    expect(result.wb.uiNotices.some((notice) => notice.tone === "danger")).toBe(false);
  });
});

describe("useWorkbench connection success notices", () => {
  it.each([
    ["en", "", "Connected to mfuu"],
    ["zh", "", "已连接到 mfuu"],
    ["en", undefined, "Connected to mfuu"],
    ["zh", null, "已连接到 mfuu"],
    ["en", "   ", "Connected to mfuu"],
    ["zh", "   ", "已连接到 mfuu"],
    ["en", "/home/deploy", "Connected to mfuu (/home/deploy)"],
    ["zh", "/home/deploy", "已连接到 mfuu（/home/deploy）"],
  ])("formats the %s notice for currentDir=%s", async (language, currentDir, expected) => {
    window.localStorage.setItem("eshell:locale", language);
    installHappyCommands();
    const session = { ...SESSION, configName: "mfuu", currentDir };
    commandHandlers.set("list_shell_sessions", async () => [session]);
    commandHandlers.set("open_shell_session", async () => session);
    const result = await renderWorkbench();

    await act(async () => {
      expect(await result.wb.connectServer(session.configId, "connection-notice-test")).toBe(true);
    });

    expect(result.wb.error).toBe("");
    expect(result.wb.uiNotices.filter((notice) => notice.tone === "success")
      .map((notice) => notice.message)).toEqual([expected]);
  });
});

describe("useWorkbench real composition: extension toggle passthrough", () => {
  it("routes setExtensionEnabled to the backend command", async () => {
    installHappyCommands();
    const seen = [];
    commandHandlers.set("set_extension_enabled", async ({ input }) => {
      seen.push(input);
      return [];
    });

    const { wb } = await renderWorkbench();
    expect(typeof wb.setExtensionEnabled).toBe("function");
    await act(async () => {
      await wb.setExtensionEnabled("eshell.sftp", false);
    });
    expect(seen).toEqual([{ extensionId: "eshell.sftp", enabled: false }]);
  });
});

describe("useWorkbench real composition: poll stability", () => {
  it("one poll updates state without immediately re-polling", async () => {
    installHappyCommands();
    const fetchCalls = [];
    commandHandlers.set("fetch_server_status", async () => {
      fetchCalls.push(Date.now());
      return { ...STATUS, fetchedAt: new Date().toISOString() };
    });

    await renderWorkbench();
    await act(async () => {
      mounted.wb.setShowStatusPanel(true);
    });
    // First poll fired on visibility; NIC auto-pick re-fires once (null -> eth0).
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const afterArm = fetchCalls.length;
    expect(mounted.wb.currentStatus).toBeTruthy();

    // The snapshot landing must NOT schedule another immediate poll.
    await act(async () => {});
    await act(async () => {});
    expect(fetchCalls.length).toBe(afterArm);
  });
});

describe("useWorkbench real composition: listener and timer stability", () => {
  it("does not re-bind the sftp-transfer listener on unrelated re-renders", async () => {
    installHappyCommands();
    await renderWorkbench();
    expect(listenerCount("sftp-transfer")).toBe(1);

    await act(async () => {
      mounted.wb.setShowCommandDraftPanel(true);
    });
    await act(async () => {
      mounted.wb.setShowCommandDraftPanel(false);
    });
    expect(listenerCount("sftp-transfer")).toBe(1);

    // The surviving listener still mirrors events into the queue.
    await act(async () => {
      fire("sftp-transfer", {
        transferId: "t-live-1",
        sessionId: SESSION.id,
        direction: "upload",
        stage: "progress",
        remotePath: "/var/x.tar",
        transferredBytes: 5,
        totalBytes: 10,
        percent: 50,
      });
    });
    expect(mounted.wb.sftpTransfers.length).toBe(1);
  });

  it("keeps the debounced save pending across unrelated re-renders", async () => {
    vi.useFakeTimers();
    try {
      installHappyCommands();
      const writes = [];
      commandHandlers.set("sftp_write_file", async (input) => {
        writes.push(input.input ?? input);
        return null;
      });

      const { wb } = await renderWorkbench();

      // Open a file through the real plugin path, then edit it.
      await act(async () => {
        await wb.openEntry({
          path: "/var/app.log",
          name: "app.log",
          entryType: "file",
          size: 4096,
        });
      });
      expect(mounted.wb.openFilePath).toBe("/var/app.log");

      await act(async () => {
        mounted.wb.handleOpenFileContentChange("changed content");
      });
      expect(mounted.wb.dirtyFile).toBe(true);

      // Unrelated re-render mid-debounce must not reset the 700ms timer.
      await act(async () => {
        mounted.wb.setShowCommandDraftPanel(true);
      });
      await vi.advanceTimersByTimeAsync(699);
      expect(writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(writes).toEqual([
        { sessionId: SESSION.id, path: "/var/app.log", content: "changed content" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
