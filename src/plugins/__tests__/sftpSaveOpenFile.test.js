import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same host double as sftpEffects.test.js: brokered commands route to a map.
const brokeredCommands = new Map();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { createPluginHostBridge } from "../../lib/plugin-host";
import { createPluginApi } from "../api";
import { useSftpOperations } from "../sftp/operations";
import { renderHook } from "./testUtils.jsx";

const makeApi = (pluginId = "eshell.sftp") => {
  const host = createPluginHostBridge();
  host.invokeExtensionApi = ({ command, args }) => {
    const handler = brokeredCommands.get(command);
    if (!handler) {
      return Promise.reject(new Error(`unbrokered command in test: ${command}`));
    }
    return Promise.resolve().then(() => handler(args ?? {}));
  };
  return createPluginApi(pluginId, { host, getContext: () => ({}) });
};

const makeCtx = (overrides = {}) => ({
  activeSessionId: "session-beta",
  openFilePath: "/etc/app.conf",
  openFileSessionId: "session-alpha",
  openFileContent: "port = 80",
  dirtyFile: true,
  runBusy: async (text, action) => action(),
  runWithSessionReconnect: async (sessionId, action) => action(sessionId),
  onError: vi.fn(),
  setDirtyFile: vi.fn(),
  api: makeApi(),
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  installFakeDom();
  brokeredCommands.clear();
});

afterEach(() => {
  uninstallFakeDom();
});

describe("saveOpenFile", () => {
  it("writes the buffer to the session the file was opened from and marks it clean", async () => {
    const writes = [];
    brokeredCommands.set("sftp_write_file", (args) => {
      writes.push(args.input);
      return null;
    });
    const ctx = makeCtx();
    const hook = await renderHook(() => useSftpOperations(ctx));

    await expect(hook.current.saveOpenFile()).resolves.toBe(true);

    expect(writes).toEqual([{ sessionId: "session-alpha", path: "/etc/app.conf", content: "port = 80" }]);
    expect(ctx.setDirtyFile).toHaveBeenCalledWith(false);
    await hook.unmount();
  });

  it("keeps the file dirty when it was edited while the write was in flight", async () => {
    const pending = deferred();
    brokeredCommands.set("sftp_write_file", () => pending.promise);
    let ctx = makeCtx();
    const hook = await renderHook(() => useSftpOperations(ctx));

    const saving = hook.current.saveOpenFile();
    await Promise.resolve();
    ctx = { ...ctx, openFileContent: "port = 8080" };
    await hook.rerender();
    pending.resolve(null);

    await expect(saving).resolves.toBe(true);
    expect(ctx.setDirtyFile).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("runs saves one at a time, each writing the latest buffer", async () => {
    const first = deferred();
    const writes = [];
    brokeredCommands.set("sftp_write_file", (args) => {
      writes.push(args.input.content);
      return writes.length === 1 ? first.promise : null;
    });
    let ctx = makeCtx({ openFileContent: "v1" });
    const hook = await renderHook(() => useSftpOperations(ctx));

    const saveOne = hook.current.saveOpenFile();
    ctx = { ...ctx, openFileContent: "v2" };
    await hook.rerender();
    const saveTwo = hook.current.saveOpenFile();
    await Promise.resolve();
    expect(writes).toEqual(["v1"]);

    first.resolve(null);
    await Promise.all([saveOne, saveTwo]);
    expect(writes).toEqual(["v1", "v2"]);
    await hook.unmount();
  });

  it("reports a failed write and leaves the file dirty", async () => {
    brokeredCommands.set("sftp_write_file", () => {
      throw new Error("permission denied");
    });
    const ctx = makeCtx();
    const hook = await renderHook(() => useSftpOperations(ctx));

    await expect(hook.current.saveOpenFile()).resolves.toBe(false);

    expect(ctx.onError).toHaveBeenCalledTimes(1);
    expect(ctx.setDirtyFile).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("does nothing when no file is open", async () => {
    const write = vi.fn(() => null);
    brokeredCommands.set("sftp_write_file", write);
    const ctx = makeCtx({ openFilePath: "", openFileSessionId: null });
    const hook = await renderHook(() => useSftpOperations(ctx));

    await expect(hook.current.saveOpenFile()).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    await hook.unmount();
  });
});
