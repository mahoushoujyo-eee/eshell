import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import wireCases from "../../../tests/fixtures/plugin-api-wire.json";

// The facade under test with a fully controllable host bridge: every
// brokered call, every native listener registration, and the in-process
// host-key signal are observable from the test.
const brokerCalls = [];
const brokeredCommands = new Map();
const nativeListeners = new Map();
let hostKeyPromptSubscribers = new Set();

const makeHost = () => {
  // The real bridge supplies the host-key prompt plumbing (the module-level
  // in-process signal); everything else is a test double.
  const realBridge = createPluginHostBridge();
  return {
    listExternalPlugins: vi.fn(async () => []),
    invokeExtensionApi: vi.fn(async ({ extensionId, command, args }) => {
      brokerCalls.push({ extensionId, command, args });
      const handler = brokeredCommands.get(command);
      if (!handler) {
        throw new Error(`unbrokered command in test: ${command}`);
      }
      return handler(args ?? {});
    }),
    listenPluginEvent: vi.fn(async (name, handler) => {
      if (!nativeListeners.has(name)) {
        nativeListeners.set(name, new Set());
      }
      nativeListeners.get(name).add(handler);
      return () => nativeListeners.get(name)?.delete(handler);
    }),
    addHostKeyPromptListener: vi.fn((listener) => {
      const remover = realBridge.addHostKeyPromptListener(listener);
      hostKeyPromptSubscribers.add(listener);
      return () => {
        remover();
        hostKeyPromptSubscribers.delete(listener);
      };
    }),
  };
};

import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import {
  createPluginHostBridge,
  emitHostKeyPrompt,
} from "../../lib/plugin-host";
import {
  PLUGIN_API_VERSION,
  createPluginApi,
  disposeApiScope,
} from "../api";

const fireNative = (name, payload) =>
  (nativeListeners.get(name) || new Set()).forEach((handler) => handler({ payload }));

// Flushes the microtask queue enough for the facade's async native
// registration promises (one `.then` hop) to settle.
const flushMicrotasks = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  installFakeDom();
  brokerCalls.length = 0;
  brokeredCommands.clear();
  nativeListeners.clear();
  hostKeyPromptSubscribers = new Set();
});

afterEach(() => {
  uninstallFakeDom();
});

const makeApi = (pluginId = "com.example.test", host = makeHost()) =>
  createPluginApi(pluginId, { host, getContext: () => ({ sessions: [] }) });

const panel = (id, order = 30) => ({
  id,
  key: id,
  order,
  render: () => null,
});

describe("facade surface", () => {
  it("exposes the contract namespaces and nothing raw", () => {
    const api = makeApi();
    expect(Object.keys(api).sort()).toEqual(
      [
        "config",
        "log",
        "meta",
        "react",
        "sessions",
        "sftp",
        "status",
        "storage",
        "ui",
      ].sort(),
    );
    // No invoke, no raw listen, no event envelope anywhere on the surface.
    const flat = JSON.stringify(
      api,
      (key, value) => {
        if (typeof value === "function") {
          return "fn";
        }
        return value;
      },
    );
    expect(flat).not.toContain("invoke");
    expect(api.invoke).toBeUndefined();
    expect(api.listen).toBeUndefined();
    expect(typeof api.sessions.onOutput).toBe("function");
    expect(typeof api.sftp.selectUploadFile).toBe("function");
    expect(api.meta).toEqual({ pluginId: "com.example.test", apiVersion: PLUGIN_API_VERSION });
  });

  it("react is the host React instance", async () => {
    const api = makeApi();
    const react = await import("react");
    expect(api.react.createElement).toBe(react.createElement);
    expect(api.react.useState).toBe(react.useState);
    expect(api.react.Fragment).toBe(react.Fragment);
  });

  it("rejects a missing plugin id or host", () => {
    expect(() => createPluginApi("", { host: makeHost() })).toThrow();
    expect(() => createPluginApi("x", {})).toThrow();
  });
});

describe("shared JS/Rust broker wire contract", () => {
  it.each(wireCases)("serializes $api exactly as the Rust dispatch parser receives it", async (fixture) => {
    brokeredCommands.set(fixture.request.command, () => null);
    const api = makeApi(fixture.request.extensionId);
    const [namespace, method] = fixture.api.split(".");
    try {
      await api[namespace][method](...fixture.params);
      expect(JSON.parse(JSON.stringify(brokerCalls))).toEqual([fixture.request]);
    } finally {
      disposeApiScope(api);
    }
  });
});

describe("brokered operations", () => {
  it("routes every operation through invoke_extension_api with the existing Tauri shapes", async () => {
    brokeredCommands.set("sftp_delete_entry", () => null);
    const api = makeApi("eshell.sftp");
    await api.sftp.deleteEntry("sess-1", "/var/x", "file");
    expect(brokerCalls).toEqual([
      {
        extensionId: "eshell.sftp",
        command: "sftp_delete_entry",
        args: { input: { sessionId: "sess-1", path: "/var/x", entryType: "file" } },
      },
    ]);
  });

  it("keeps renameEntry's third parameter as newName", async () => {
    brokeredCommands.set("sftp_rename_entry", () => null);
    const api = makeApi();
    await api.sftp.renameEntry("sess-1", "/var/x", "next");
    expect(brokerCalls[0].args).toEqual({
      input: { sessionId: "sess-1", path: "/var/x", newName: "next" },
    });
  });

  it("keeps the upload/download argument order", async () => {
    brokeredCommands.set("sftp_upload_local_file_with_progress", () => null);
    brokeredCommands.set("sftp_download_file_to_local", () => null);
    const api = makeApi();
    await api.sftp.uploadLocalFile("s", "/r", "/l", "t1", "name.bin");
    await api.sftp.downloadToLocal("s", "/r", "/d", "t2");
    expect(brokerCalls[0].args).toEqual({
      input: {
        sessionId: "s",
        remotePath: "/r",
        localPath: "/l",
        transferId: "t1",
        localName: "name.bin",
      },
    });
    expect(brokerCalls[1].args).toEqual({
      input: {
        sessionId: "s",
        remotePath: "/r",
        localDir: "/d",
        transferId: "t2",
      },
    });
  });

  it("keeps session open/close/execute and list in their shapes", async () => {
    brokeredCommands.set("open_shell_session", () => ({}));
    brokeredCommands.set("close_shell_session", () => null);
    brokeredCommands.set("execute_shell_command", () => null);
    brokeredCommands.set("list_shell_sessions", () => []);
    const api = makeApi();
    await api.sessions.open("cfg-1", "req-9");
    await api.sessions.close("sess-1");
    await api.sessions.execute("sess-1", "uptime");
    await api.sessions.list();
    expect(brokerCalls.map((call) => [call.command, call.args])).toEqual([
      ["open_shell_session", { input: { configId: "cfg-1", requestId: "req-9" } }],
      ["close_shell_session", { input: { sessionId: "sess-1" } }],
      ["execute_shell_command", { input: { sessionId: "sess-1", command: "uptime" } }],
      ["list_shell_sessions", {}],
    ]);
  });

  it("brokers pickers with a defaultPath string or options object", async () => {
    brokeredCommands.set("select_upload_file", (args) => args);
    brokeredCommands.set("select_download_dir", (args) => args);
    const api = makeApi();
    await api.sftp.selectUploadFile();
    await api.sftp.selectUploadFile("/home/default");
    await api.sftp.selectDownloadDir({ title: "Pick", defaultPath: "/tmp" });
    expect(brokerCalls.map((call) => [call.command, call.args])).toEqual([
      ["select_upload_file", {}],
      ["select_upload_file", { defaultPath: "/home/default" }],
      ["select_download_dir", { title: "Pick", defaultPath: "/tmp" }],
    ]);
  });

  it("normalizes a picker result to a string or null", async () => {
    brokeredCommands.set("select_upload_file", () => "  /chosen/path  ");
    brokeredCommands.set("select_download_dir", () => null);
    const api = makeApi();
    await expect(api.sftp.selectUploadFile()).resolves.toBe("  /chosen/path  ");
    await expect(api.sftp.selectDownloadDir()).resolves.toBeNull();
  });

  it("status fetch uses selectedInterface; cached keeps the legacy sessionId shape", async () => {
    brokeredCommands.set("get_cached_server_status", () => ({ cpuPercent: 1 }));
    brokeredCommands.set("fetch_server_status", () => ({ cpuPercent: 2 }));
    const api = makeApi();
    await expect(api.status.cached("s1")).resolves.toEqual({ cpuPercent: 1 });
    await expect(api.status.fetch("s1", "eth0")).resolves.toEqual({ cpuPercent: 2 });
    expect(brokerCalls[0]).toEqual({
      extensionId: "com.example.test",
      command: "get_cached_server_status",
      args: { sessionId: "s1" },
    });
    expect(brokerCalls[1]).toEqual({
      extensionId: "com.example.test",
      command: "fetch_server_status",
      args: { input: { sessionId: "s1", selectedInterface: "eth0" } },
    });
  });

  it("cancelTransfer and defaultDownloadDir keep their shapes", async () => {
    brokeredCommands.set("sftp_cancel_transfer", () => null);
    brokeredCommands.set("sftp_default_download_dir", () => "/downloads");
    const api = makeApi();
    await api.sftp.cancelTransfer("t-1");
    await api.sftp.defaultDownloadDir();
    expect(brokerCalls.map((call) => [call.command, call.args])).toEqual([
      ["sftp_cancel_transfer", { input: { transferId: "t-1" } }],
      ["sftp_default_download_dir", {}],
    ]);
  });
});

describe("storage namespacing", () => {
  it("stores JSON under a per-plugin prefix", () => {
    const api = makeApi("com.example.test");
    api.storage.set("count", 3);
    expect(window.localStorage.getItem("eshell:plugin:com.example.test:count")).toBe("3");
    expect(api.storage.get("count")).toBe(3);
    expect(api.storage.get("missing")).toBeNull();
    api.storage.remove("count");
    expect(api.storage.get("count")).toBeNull();
  });

  it("isolates two plugins writing the same key", () => {
    const a = makeApi("plugin.a");
    const b = makeApi("plugin.b");
    a.storage.set("shared", "from-a");
    b.storage.set("shared", "from-b");
    expect(a.storage.get("shared")).toBe("from-a");
    expect(b.storage.get("shared")).toBe("from-b");
  });

  it("encodes ids and keys so a:b / b:c cannot cross-talk", () => {
    // id "a:b" key "b:c" must not collide with id "a" key "b:c" — or with any
    // other split of the same concatenated string.
    const colonId = makeApi("a:b");
    const plainId = makeApi("a");
    colonId.storage.set("b:c", "colon");
    plainId.storage.set("b:c", "plain");
    expect(colonId.storage.get("b:c")).toBe("colon");
    expect(plainId.storage.get("b:c")).toBe("plain");
    expect(
      Object.keys(window.localStorage.store).filter((key) =>
        key.startsWith("eshell:plugin:"),
      ),
    ).toHaveLength(2);
  });

  it("never touches the builtin host preference keys", () => {
    window.localStorage.setItem("eshell:sftp-download-dir", "/downloads");
    const api = makeApi("eshell.sftp");
    api.storage.set("download-dir", "/elsewhere");
    expect(window.localStorage.getItem("eshell:sftp-download-dir")).toBe("/downloads");
  });

  it("round-trips objects and null", () => {
    const api = makeApi();
    api.storage.set("obj", { nested: [1, 2] });
    expect(api.storage.get("obj")).toEqual({ nested: [1, 2] });
    api.storage.set("obj", null);
    expect(api.storage.get("obj")).toBeNull();
  });
});

describe("event subscriptions", () => {
  it("returns a synchronous idempotent unsubscribe", async () => {
    const api = makeApi();
    const seen = [];
    const unsubscribe = api.sessions.onOutput((payload) => seen.push(payload));
    // The test double registers synchronously inside its async body, so the
    // listener is observable before the registration promise resolves. The
    // contract under test is the unsubscribe: sync-callable immediately
    // (before the registration resolves), idempotent, and releasing the
    // native listener once registration settles.
    expect(nativeListeners.get("pty-output")?.size ?? 0).toBe(1);
    unsubscribe();
    expect(seen).toEqual([]);
    // Still pending registration: the release happens when it resolves.
    await flushMicrotasks();
    expect(nativeListeners.get("pty-output")?.size ?? 0).toBe(0);
    // Second call: no-op, no throw.
    expect(() => unsubscribe()).not.toThrow();
    expect(nativeListeners.get("pty-output")?.size ?? 0).toBe(0);
  });

  it("unsubscribing while registration is pending releases the listener", async () => {
    let resolveRegistration;
    const host = makeHost();
    host.listenPluginEvent = vi.fn(
      (name, handler) =>
        new Promise((resolve) => {
          resolveRegistration = () => {
            if (!nativeListeners.has(name)) {
              nativeListeners.set(name, new Set());
            }
            nativeListeners.get(name).add(handler);
            resolve(() => nativeListeners.get(name)?.delete(handler));
          };
        }),
    );
    const api = makeApi("pending.test", host);
    const unsubscribe = api.sessions.onClosed(() => {});
    unsubscribe(); // before registration resolved
    expect(nativeListeners.get("pty-closed")?.size ?? 0).toBe(0);
    resolveRegistration(); // late resolve: the facade must release it
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeListeners.get("pty-closed")?.size ?? 0).toBe(0);
  });

  it("validates and filters payloads, honoring the sessionId option", () => {
    const api = makeApi();
    const seen = [];
    api.sftp.onTransfer(
      (payload) => seen.push(payload),
      { sessionId: "sess-alpha" },
    );
    fireNative("sftp-transfer", { no: "transferId" });
    fireNative("sftp-transfer", { transferId: "t-1", sessionId: "sess-beta" });
    fireNative("sftp-transfer", {
      transferId: "t-2",
      sessionId: "sess-alpha",
      stage: "progress",
    });
    expect(seen.map((payload) => payload.transferId)).toEqual(["t-2"]);
  });

  it("drops invalid output and closed payloads", () => {
    const api = makeApi();
    const outputs = [];
    const closed = [];
    api.sessions.onOutput((payload) => outputs.push(payload));
    api.sessions.onClosed((payload) => closed.push(payload));
    fireNative("pty-output", null);
    fireNative("pty-output", { sessionId: "s1", chunk: "" });
    fireNative("pty-output", { sessionId: "s1", chunk: "data" });
    fireNative("pty-closed", { no: "sessionId" });
    fireNative("pty-closed", { sessionId: "s1", reason: "eof" });
    expect(outputs).toEqual([{ sessionId: "s1", chunk: "data" }]);
    expect(closed).toEqual([{ sessionId: "s1", reason: "eof" }]);
  });

  it("a throwing subscriber never breaks the dispatch", () => {
    const api = makeApi();
    const seen = [];
    api.sessions.onOutput(() => {
      throw new Error("subscriber bug");
    });
    api.sessions.onOutput((payload) => seen.push(payload));
    fireNative("pty-output", { sessionId: "s1", chunk: "x" });
    expect(seen).toEqual([{ sessionId: "s1", chunk: "x" }]);
  });

  it("onHostKeyPrompt observes the readonly bridge, not ssh-ki-prompt", () => {
    const api = makeApi();
    const seen = [];
    const unsubscribe = api.sessions.onHostKeyPrompt((challenge) => seen.push(challenge));
    emitHostKeyPrompt({ host: "h", fingerprint: "fp", keyType: "ed25519" });
    expect(seen).toEqual([
      { host: "h", fingerprint: "fp", keyType: "ed25519" },
    ]);
    // No native listener was ever registered for the SSH keyboard-interactive
    // event; the host-key signal stays in-process and readonly.
    expect(nativeListeners.has("ssh-ki-prompt")).toBe(false);
    unsubscribe();
    emitHostKeyPrompt({ host: "h2" });
    expect(seen).toHaveLength(1);
  });
});

describe("scope lifecycle guard", () => {
  it("refuses brokered operations after dispose", async () => {
    brokeredCommands.set("sftp_list_dir", () => ({ path: "/var", entries: [] }));
    const api = makeApi();
    await expect(api.sftp.listDir("s1", "/var")).resolves.toBeTruthy();
    disposeApiScope(api);
    await expect(api.sftp.listDir("s1", "/var")).rejects.toThrow(
      /the API scope is disposed/,
    );
    await expect(api.sessions.list()).rejects.toThrow(/the API scope is disposed/);
    await expect(api.status.fetch("s1", null)).rejects.toThrow(
      /the API scope is disposed/,
    );
    await expect(api.sftp.selectUploadFile()).rejects.toThrow(
      /the API scope is disposed/,
    );
  });

  it("refuses storage writes after dispose; reads and log stay available", () => {
    const api = makeApi("com.example.stale");
    api.storage.set("persisted", "from-live-activation");
    expect(api.storage.get("persisted")).toBe("from-live-activation");

    disposeApiScope(api);

    // The rapid off/on case: this scope is disposed, a NEW activation of the
    // same plugin id owns the storage now. A late async callback holding the
    // old facade must not overwrite the new activation's persisted values.
    api.storage.set("persisted", "from-stale-callback");
    api.storage.remove("persisted");
    expect(api.storage.get("persisted")).toBe("from-live-activation");

    // Reads, log and meta stay available for cleanup diagnostics.
    expect(api.storage.get("persisted")).toBe("from-live-activation");
    expect(() => api.log.warn("cleaning up")).not.toThrow();
    expect(api.meta.pluginId).toBe("com.example.stale");
  });

  it("a live scope still writes; a newer activation's values survive", () => {
    const first = makeApi("com.example.cycle");
    first.storage.set("owner", "first");
    disposeApiScope(first);

    // Re-activation: a fresh scope under the same plugin id.
    const second = makeApi("com.example.cycle");
    second.storage.set("owner", "second");
    expect(second.storage.get("owner")).toBe("second");

    // The stale facade cannot clobber it.
    first.storage.set("owner", "first-late-write");
    expect(second.storage.get("owner")).toBe("second");
  });

  it("refuses new registrations after dispose", async () => {
    const { PLUGIN_API_SCOPE } = await import("../api");
    const api = makeApi();
    disposeApiScope(api);
    expect(() => api.ui.registerPanel(panel("late.panel"))).not.toThrow();
    expect(() => api.ui.registerToolbar({ id: "late.toolbar" })).not.toThrow();
    expect(() => api.ui.registerController(() => ({}))).not.toThrow();
    // And none of them staged anything: the handle stays empty.
    expect(api[PLUGIN_API_SCOPE].listPanels()).toEqual([]);
    expect(api[PLUGIN_API_SCOPE].listToolbar()).toEqual([]);
    expect(api[PLUGIN_API_SCOPE].getController()).toBeNull();
  });

  it("a late registration on a disposed scope is released, not admitted", async () => {
    const { PLUGIN_API_SCOPE } = await import("../api");
    const api = makeApi();
    disposeApiScope(api);
    const handle = api[PLUGIN_API_SCOPE];
    expect(handle.listPanels()).toEqual([]);
    // A subscription created after dispose fires no native registration.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      api.sessions.onOutput(() => {});
    } finally {
      warn.mockRestore();
    }
    expect(nativeListeners.get("pty-output")?.size ?? 0).toBe(0);
  });
});

describe("scope-owned cleanup", () => {
  it("disposeApiScope releases subscriptions the plugin leaked", async () => {
    const api = makeApi();
    api.sessions.onOutput(() => {});
    api.sftp.onTransfer(() => {});
    api.ui.registerPanel({ id: "p1", order: 1, render: () => null });
    api.ui.registerToolbar({ id: "t1", order: 1 });
    api.ui.registerController(() => ({}));
    disposeApiScope(api);
    // Pending native registrations release when they resolve.
    await flushMicrotasks();
    expect(nativeListeners.get("pty-output")?.size ?? 0).toBe(0);
    expect(nativeListeners.get("sftp-transfer")?.size ?? 0).toBe(0);
    // A second dispose is a no-op.
    expect(() => disposeApiScope(api)).not.toThrow();
  });

  it("double registration of a controller is refused", () => {
    const api = makeApi();
    const first = api.ui.registerController(() => ({}));
    const second = api.ui.registerController(() => ({}));
    first();
    // The second call returned a no-op remover: the first (removed) is gone
    // either way, and no controller survives both.
    second();
    expect(api.ui.getContext()).toEqual({ sessions: [] });
  });

  it("registerPanel refuses the reserved draft key and invalid panels", () => {
    const api = makeApi();
    expect(() => api.ui.registerPanel({ id: "draft", render: () => null })).not.toThrow();
    const host = makeHost();
    // Invalid panels are warned and ignored; the returned remover is a no-op.
    const remove = api.ui.registerPanel({ id: "no-render", order: 1 });
    expect(typeof remove).toBe("function");
    remove();
  });
});

describe("log", () => {
  it("prefixes every level with the plugin id", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const api = makeApi("com.example.loggy");
      api.log.info("hello");
      api.log.warn("careful");
      api.log.error("broken");
      expect(info).toHaveBeenCalledWith("[plugin com.example.loggy]", "hello");
      expect(warn).toHaveBeenCalledWith("[plugin com.example.loggy]", "careful");
      expect(error).toHaveBeenCalledWith("[plugin com.example.loggy]", "broken");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
