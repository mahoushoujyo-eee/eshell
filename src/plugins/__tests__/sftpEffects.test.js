import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The migrated sftp effects talk to the injected plugin API (`ctx.api`),
// never to `tauri-api` or Tauri events directly. The host bridge below is a
// test double: one map of brokered commands, one map of native listeners.
// This is the same surface `src/lib/plugin-host.js` injects in production.
const brokeredCommands = new Map();
const nativeListeners = new Map();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, handler) => {
    if (!nativeListeners.has(name)) {
      nativeListeners.set(name, new Set());
    }
    nativeListeners.get(name).add(handler);
    return () => nativeListeners.get(name)?.delete(handler);
  }),
}));

import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { createPluginHostBridge } from "../../lib/plugin-host";
import { createPluginApi } from "../api";
import { useSftpEffects } from "../sftp/effects";
import { renderHook } from "./testUtils.jsx";

// A facade whose brokered commands route to the test double.
const makeApi = (pluginId = "eshell.sftp") => {
  const host = createPluginHostBridge();
  host.invokeExtensionApi = ({ extensionId, command, args }) => {
    if (extensionId !== pluginId) {
      return Promise.reject(new Error(`unexpected extensionId ${extensionId}`));
    }
    const handler = brokeredCommands.get(command);
    if (!handler) {
      return Promise.reject(new Error(`unbrokered command in test: ${command}`));
    }
    return Promise.resolve(handler(args ?? {}));
  };
  return createPluginApi(pluginId, { host, getContext: () => ({}) });
};

const makeCtx = (overrides = {}) => ({
  activeSessionId: "session-alpha",
  currentPath: "/var",
  showSftpPanel: true,
  dirtyFile: false,
  openFilePath: "",
  openFileSessionId: null,
  openFileContent: "",
  saveTimerRef: { current: null },
  runBusy: async (text, action) => action(),
  runWithSessionReconnect: async (sessionId, action) => action(sessionId),
  onError: vi.fn(),
  setSftpTransfers: vi.fn(),
  setSftpEntries: vi.fn(),
  setSelectedEntry: vi.fn(),
  setDirtyFile: vi.fn(),
  api: makeApi(),
  ...overrides,
});

const fireTransferEvent = (payload) =>
  (nativeListeners.get("sftp-transfer") || new Set()).forEach((handler) =>
    handler({ payload }),
  );

beforeEach(() => {
  installFakeDom();
  brokeredCommands.clear();
  nativeListeners.clear();
});

afterEach(() => {
  uninstallFakeDom();
});

describe("useSftpEffects transfer mirroring", () => {
  it("mirrors sftp-transfer events into the queue while the panel is hidden", async () => {
    // Closing the panel must not cancel or stop tracking transfers.
    const ctx = makeCtx({ showSftpPanel: false });
    const refreshSftp = vi.fn(async () => {});
    await renderHook(() => useSftpEffects(ctx, { refreshSftp }));

    fireTransferEvent({
      transferId: "t-1",
      sessionId: "session-alpha",
      direction: "upload",
      stage: "progress",
      remotePath: "/var/app.log",
      localPath: "/tmp/app.log",
      fileName: "app.log",
      transferredBytes: 100,
      totalBytes: 400,
      percent: 25,
    });

    expect(ctx.setSftpTransfers).toHaveBeenCalledTimes(1);
    expect(refreshSftp).not.toHaveBeenCalled();
  });

  it("refreshes the browsed directory after an upload completes into it", async () => {
    const ctx = makeCtx({ currentPath: "/var" });
    const refreshSftp = vi.fn(async () => {});
    await renderHook(() => useSftpEffects(ctx, { refreshSftp }));

    fireTransferEvent({
      transferId: "t-2",
      sessionId: "session-alpha",
      direction: "upload",
      stage: "completed",
      remotePath: "/var/new.tar",
      localPath: "/tmp/new.tar",
      fileName: "new.tar",
      transferredBytes: 10,
      totalBytes: 10,
      percent: 100,
    });

    // Parent of /var/new.tar is /var, which is the browsed path.
    expect(refreshSftp).toHaveBeenCalledWith("/var");
  });

  it("does not refresh when the upload landed elsewhere", async () => {
    const ctx = makeCtx({ currentPath: "/etc" });
    const refreshSftp = vi.fn(async () => {});
    await renderHook(() => useSftpEffects(ctx, { refreshSftp }));

    fireTransferEvent({
      transferId: "t-3",
      sessionId: "session-alpha",
      direction: "upload",
      stage: "completed",
      remotePath: "/var/new.tar",
      localPath: "/tmp/new.tar",
      fileName: "new.tar",
      transferredBytes: 10,
      totalBytes: 10,
      percent: 100,
    });

    expect(refreshSftp).not.toHaveBeenCalled();
  });

  it("ignores events from another session", async () => {
    const ctx = makeCtx({ currentPath: "/var" });
    const refreshSftp = vi.fn(async () => {});
    await renderHook(() => useSftpEffects(ctx, { refreshSftp }));

    fireTransferEvent({
      transferId: "t-4",
      sessionId: "session-beta",
      direction: "upload",
      stage: "completed",
      remotePath: "/var/new.tar",
      localPath: "/tmp/new.tar",
      fileName: "new.tar",
      transferredBytes: 10,
      totalBytes: 10,
      percent: 100,
    });

    expect(ctx.setSftpTransfers).toHaveBeenCalledTimes(1); // still mirrored
    expect(refreshSftp).not.toHaveBeenCalled();
  });

  it("drops malformed events without touching the queue", async () => {
    const ctx = makeCtx();
    const refreshSftp = vi.fn(async () => {});
    await renderHook(() => useSftpEffects(ctx, { refreshSftp }));

    fireTransferEvent(null);
    fireTransferEvent({ no: "transferId" });
    fireTransferEvent({ transferId: "t-5", sessionId: "", direction: "upload" });

    expect(ctx.setSftpTransfers).not.toHaveBeenCalled();
  });
});

describe("useSftpEffects debounced save", () => {
  it("saves after 700ms of quiet, targeted at the owning session", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async () => null);
      // The broker passes the existing Tauri shape: args = { input: {...} }.
      brokeredCommands.set("sftp_write_file", (args) => {
        const { sessionId, path, content } = args?.input ?? {};
        write(sessionId, path, content);
        return null;
      });
      const ctx = makeCtx({
        dirtyFile: true,
        openFilePath: "/var/app.log",
        openFileSessionId: "session-alpha",
        openFileContent: "hello",
        runWithSessionReconnect: async (sessionId, action) => action(sessionId),
      });
      const refreshSftp = vi.fn(async () => {});
      const utils = await renderHook(() => useSftpEffects(ctx, { refreshSftp }));

      await vi.advanceTimersByTimeAsync(600);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("session-alpha", "/var/app.log", "hello");
      expect(ctx.setDirtyFile).toHaveBeenCalledWith(false);
      await utils.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while the buffer is clean", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async () => null);
      brokeredCommands.set("sftp_write_file", () => {
        write();
        return null;
      });
      const ctx = makeCtx({ dirtyFile: false });
      const refreshSftp = vi.fn(async () => {});
      const utils = await renderHook(() => useSftpEffects(ctx, { refreshSftp }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(write).not.toHaveBeenCalled();
      await utils.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
