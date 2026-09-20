import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeHandlers = new Map();
const listeners = new Map();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    const handler = invokeHandlers.get(command);
    if (!handler) throw new Error(`unmocked command: ${command}`);
    return handler(args);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { act } from "react";
import { listen } from "@tauri-apps/api/event";
import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { useExtensionState } from "../extensions/extensionState";
import { renderHook } from "./testUtils.jsx";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const rows = (sftpEnabled = true, statusEnabled = true) => [
  ["eshell.sftp", "sftp", sftpEnabled, 10],
  ["eshell.server-monitor", "status", statusEnabled, 20],
].map(([id, panelId, enabled, order]) => ({
  id,
  displayName: id,
  version: "1.0.0",
  apiVersion: 1,
  builtin: true,
  defaultEnabled: true,
  enabled,
  contributes: { panels: [{ id: panelId, order }] },
}));

const mounted = new Set();
const mount = async () => {
  const result = await renderHook(() => useExtensionState());
  mounted.add(result);
  return result;
};
const unmount = async (result) => {
  await result.unmount();
  mounted.delete(result);
};
const fireChanged = (payload) => listeners.get("extensions-changed")?.({ payload });

beforeEach(() => {
  installFakeDom();
  invokeHandlers.clear();
  listeners.clear();
  listen.mockReset();
  listen.mockImplementation(async (name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
  invokeHandlers.set("list_extensions", () => rows());
});

afterEach(async () => {
  for (const result of [...mounted]) await unmount(result);
  uninstallFakeDom();
});

describe("useExtensionState synchronization", () => {
  it("waits for listener registration to complete before listing extensions", async () => {
    const registration = deferred();
    listen.mockImplementation(() => registration.promise);
    const list = vi.fn(() => rows());
    invokeHandlers.set("list_extensions", list);
    await mount();
    expect(listen).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();

    await act(async () => { registration.resolve(() => {}); });
    expect(list).toHaveBeenCalledOnce();
  });

  it("drops an initial snapshot that resolves after a newer event", async () => {
    const initial = deferred();
    invokeHandlers.set("list_extensions", () => initial.promise);
    const result = await mount();
    await act(async () => {
      fireChanged(rows(false));
      initial.resolve(rows(true));
    });
    expect(result.current.isEnabled("eshell.sftp")).toBe(false);
  });

  it("accepts the initial snapshot when no newer write occurred", async () => {
    invokeHandlers.set("list_extensions", () => rows(false));
    const result = await mount();
    expect(result.current.isEnabled("eshell.sftp")).toBe(false);
    expect(result.current.isEnabled("eshell.server-monitor")).toBe(true);
  });

  it("keeps state unchanged and propagates a rejected busy-disable", async () => {
    invokeHandlers.set("set_extension_enabled", () => {
      throw new Error("operations in flight");
    });
    const result = await mount();
    await act(async () => {
      await expect(result.current.setExtensionEnabled("eshell.sftp", false))
        .rejects.toThrow("operations in flight");
    });
    expect(result.current.isEnabled("eshell.sftp")).toBe(true);
  });

  it("changes state only after receiving the confirmed descriptor list", async () => {
    const response = deferred();
    const setter = vi.fn(() => response.promise);
    invokeHandlers.set("set_extension_enabled", setter);
    const result = await mount();
    let request;
    await act(async () => { request = result.current.setExtensionEnabled("eshell.sftp", false); });
    expect(setter).toHaveBeenCalledWith({ input: { extensionId: "eshell.sftp", enabled: false } });
    expect(result.current.isEnabled("eshell.sftp")).toBe(true);
    await act(async () => { response.resolve(rows(false)); await request; });
    expect(result.current.isEnabled("eshell.sftp")).toBe(false);
  });

  it("uses the backend descriptors rather than guessing from the requested boolean", async () => {
    invokeHandlers.set("set_extension_enabled", () => rows(true, false));
    const result = await mount();
    await act(async () => { await result.current.setExtensionEnabled("eshell.sftp", false); });
    expect(result.current.isEnabled("eshell.sftp")).toBe(true);
    expect(result.current.isEnabled("eshell.server-monitor")).toBe(false);
  });

  it("does not let a delayed command reply overwrite a newer event", async () => {
    const response = deferred();
    invokeHandlers.set("set_extension_enabled", () => response.promise);
    const result = await mount();
    let request;
    await act(async () => { request = result.current.setExtensionEnabled("eshell.sftp", false); });
    await act(async () => {
      fireChanged(rows(true, false));
      response.resolve(rows(false, true));
      await request;
    });
    expect(result.current.isEnabled("eshell.sftp")).toBe(true);
    expect(result.current.isEnabled("eshell.server-monitor")).toBe(false);
  });

  it("serializes local toggles so delayed replies cannot reverse their order", async () => {
    const first = deferred();
    const setter = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => rows(true));
    invokeHandlers.set("set_extension_enabled", setter);
    const result = await mount();
    let disable;
    let enable;
    await act(async () => {
      disable = result.current.setExtensionEnabled("eshell.sftp", false);
      enable = result.current.setExtensionEnabled("eshell.sftp", true);
    });
    expect(setter).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(rows(false));
      await Promise.all([disable, enable]);
    });
    expect(setter).toHaveBeenCalledTimes(2);
    expect(result.current.isEnabled("eshell.sftp")).toBe(true);
  });

  it("a failed toggle does not prevent the next toggle from succeeding", async () => {
    const setter = vi.fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(rows(false));
    invokeHandlers.set("set_extension_enabled", setter);
    const result = await mount();
    await act(async () => {
      await expect(result.current.setExtensionEnabled("eshell.sftp", false)).rejects.toThrow("busy");
      await result.current.setExtensionEnabled("eshell.sftp", false);
    });
    expect(result.current.isEnabled("eshell.sftp")).toBe(false);
  });

  it("does not let a stale initial snapshot undo a confirmed toggle", async () => {
    const initial = deferred();
    invokeHandlers.set("list_extensions", () => initial.promise);
    invokeHandlers.set("set_extension_enabled", () => rows(false));
    const result = await mount();
    await act(async () => { await result.current.setExtensionEnabled("eshell.sftp", false); });
    await act(async () => { initial.resolve(rows()); });
    expect(result.current.isEnabled("eshell.sftp")).toBe(false);
  });

  it("unsubscribes a late registration after unmount without starting a list request", async () => {
    const registration = deferred();
    const release = vi.fn();
    const list = vi.fn(() => rows());
    listen.mockImplementation(() => registration.promise);
    invokeHandlers.set("list_extensions", list);
    const result = await mount();
    await unmount(result);
    await act(async () => { registration.resolve(release); });
    expect(release).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("treats an empty authoritative list and unknown extensions as disabled", async () => {
    invokeHandlers.set("list_extensions", () => []);
    const result = await mount();
    expect(result.current.extensions).toEqual([]);
    expect(result.current.isEnabled("eshell.sftp")).toBe(false);
    expect(result.current.isEnabled("eshell.not-registered")).toBe(false);
  });
});
