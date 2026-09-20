import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loader races, tested with real async: every case awaits the loader's own
// promise chains (never asserting call order as a proxy for awaiting), then
// inspects the registry. The dynamic-import boundary is substituted through
// `setPluginBundleImporter` with controllable module namespaces; the catalog
// and extensions-changed paths use the Tauri command/event mocks.
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

import {
  listExternalPluginDescriptors,
  loadExternalPlugins,
  setPluginBundleImporter,
  unloadExternalPlugins,
} from "../loader";
import {
  getPlugin,
  getRegistryVersion,
  listPanelContributions,
  listPlugins,
  registerPlugin,
  subscribeRegistry,
} from "../registry";
import { registerBuiltinPlugins } from "../index.jsx";
import { defaultExtensionState } from "../extensions/extensionState";

const fireExtensionsChanged = (payload) =>
  (eventListeners.get("extensions-changed") || new Set()).forEach((handler) =>
    handler({ payload }),
  );

const descriptor = (id, overrides = {}) => ({
  id,
  displayName: id,
  version: "1.0.0",
  apiVersion: 1,
  builtin: false,
  defaultEnabled: true,
  enabled: true,
  main: "index.js",
  bundleUrl: `http://plugin.localhost/${encodeURIComponent(id)}/index.js`,
  contributes: { panels: [{ id: `${id}.panel`, order: 30 }] },
  ...overrides,
});

// A controllable deferred: the test decides when an activation's import or
// activate settles, so a race is a real interleaving, not a mock sequence.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

const panel = (id, order = 30) => ({
  id,
  key: id,
  order,
  render: () => null,
});

beforeEach(() => {
  commandHandlers.clear();
  eventListeners.clear();
  commandHandlers.set("list_extensions", async () => defaultExtensionState());
  commandHandlers.set("list_external_plugins", async () => []);
});

afterEach(() => {
  unloadExternalPlugins();
});

const installAlphaCatalog = ({ enabled = true } = {}) => {
  commandHandlers.set("list_extensions", async () => [
    ...defaultExtensionState(),
    descriptor("com.example.alpha", { enabled }),
  ]);
  commandHandlers.set("list_external_plugins", async () => [
    descriptor("com.example.alpha", { enabled }),
  ]);
};

describe("loadExternalPlugins", () => {
  it("registers an enabled external plugin with the contract shape", async () => {
    const activated = [];
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        activated.push(api.meta.pluginId);
        api.ui.registerPanel(panel("com.example.alpha.panel"));
        api.ui.registerToolbar({ id: "com.example.alpha.toolbar", order: 30 });
        api.ui.registerController(() => ({ ready: true }));
        return () => activated.push("disposed");
      },
    }));
    installAlphaCatalog();

    await loadExternalPlugins();

    const plugin = getPlugin("com.example.alpha");
    expect(plugin).toMatchObject({ id: "com.example.alpha", builtin: false });
    expect(typeof plugin.createController).toBe("function");
    expect(plugin.panels()).toHaveLength(1);
    expect(plugin.toolbar()).toHaveLength(1);
    expect(activated).toEqual(["com.example.alpha"]);
    expect(plugin.api).toBeTruthy();
    expect(plugin.api.meta.pluginId).toBe("com.example.alpha");
  });

  it("await loadExternalPlugins: registered before it resolves (deferred import)", async () => {
    // The startup path must await its activation attempts: when the dynamic
    // import is deferred, nothing is registered mid-flight, and everything
    // is registered the moment loadExternalPlugins resolves.
    const gate = deferred();
    setPluginBundleImporter(async () => {
      await gate.promise;
      return { activate: (api) => api.ui.registerPanel(panel("com.example.alpha.panel")) };
    });
    installAlphaCatalog();

    const loading = loadExternalPlugins();
    await flushMicrotasks(10);
    expect(getPlugin("com.example.alpha")).toBeNull();

    gate.resolve();
    await loading;
    expect(getPlugin("com.example.alpha")).not.toBeNull();
    expect(
      listPlugins().find((plugin) => plugin.id === "com.example.alpha")?.panels(),
    ).toHaveLength(1);
  });

  it("does not execute a disabled plugin's code", async () => {
    const activated = [];
    setPluginBundleImporter(async () => ({
      activate: () => activated.push("must not run"),
    }));
    installAlphaCatalog({ enabled: false });

    await loadExternalPlugins();
    await flushMicrotasks();

    expect(activated).toEqual([]);
    expect(getPlugin("com.example.alpha")).toBeNull();
    // The descriptor is still known to the management surface.
    expect(listExternalPluginDescriptors().map((row) => row.id)).toEqual([
      "com.example.alpha",
    ]);
  });

  it("skips a failing import without blocking other plugins", async () => {
    setPluginBundleImporter(async (bundleUrl) => {
      if (bundleUrl.includes("alpha")) {
        throw new Error("bundle 404");
      }
      return {
        activate: (api) => api.ui.registerPanel(panel("com.example.beta.panel")),
      };
    });
    commandHandlers.set("list_extensions", async () => [
      ...defaultExtensionState(),
      descriptor("com.example.alpha"),
      descriptor("com.example.beta"),
    ]);
    commandHandlers.set("list_external_plugins", async () => [
      descriptor("com.example.alpha"),
      descriptor("com.example.beta"),
    ]);

    await loadExternalPlugins();

    expect(getPlugin("com.example.alpha")).toBeNull();
    expect(getPlugin("com.example.beta")).not.toBeNull();
  });

  it("skips a module with no activate export", async () => {
    setPluginBundleImporter(async () => ({ something: true }));
    installAlphaCatalog();
    await loadExternalPlugins();
    expect(getPlugin("com.example.alpha")).toBeNull();
  });

  it("rolls back a conflicting registration instead of registering it", async () => {
    registerBuiltinPlugins();
    setPluginBundleImporter(async () => ({
      // Conflicts with the builtin sftp panel key.
      activate: (api) => api.ui.registerPanel(panel("sftp", 5)),
    }));
    installAlphaCatalog();

    await loadExternalPlugins();

    expect(getPlugin("com.example.alpha")).toBeNull();
    // The builtin contributions are untouched.
    const ids = listPanelContributions().map((entry) => entry.pluginId);
    expect(ids.sort()).toEqual(["eshell.sftp", "eshell.server-monitor"].sort());
  });

  it("never publishes a draft panel key", async () => {
    setPluginBundleImporter(async () => ({
      // The facade refuses the reserved key at registration time; the
      // loader only ever sees valid staged contributions.
      activate: (api) => api.ui.registerPanel({ id: "draft", order: 5, render: () => null }),
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    expect(listPanelContributions().map((entry) => entry.key)).not.toContain("draft");
  });

  it("times out an activation whose import never settles", async () => {
    vi.useFakeTimers();
    try {
      // A TLA inside the plugin bundle: the import promise never settles.
      setPluginBundleImporter(
        () =>
          new Promise(() => {}),
      );
      installAlphaCatalog();
      const loading = loadExternalPlugins();
      await vi.advanceTimersByTimeAsync(11000);
      await loading;
      expect(getPlugin("com.example.alpha")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out an activate that never settles", async () => {
    vi.useFakeTimers();
    try {
      setPluginBundleImporter(async () => ({
        activate: () => new Promise(() => {}),
      }));
      installAlphaCatalog();
      const loading = loadExternalPlugins();
      await vi.advanceTimersByTimeAsync(11000);
      await loading;
      expect(getPlugin("com.example.alpha")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block startup when the catalog fetch fails", async () => {
    commandHandlers.set("list_extensions", async () => {
      throw new Error("backend down");
    });
    commandHandlers.set("list_external_plugins", async () => {
      throw new Error("backend down");
    });
    await expect(loadExternalPlugins()).resolves.toBeUndefined();
    expect(listPlugins().filter((plugin) => plugin.builtin === false)).toEqual([]);
  });

  it("loads once; a second call is a no-op", async () => {
    const imports = [];
    setPluginBundleImporter(async (bundleUrl) => {
      imports.push(bundleUrl);
      return { activate: () => {} };
    });
    installAlphaCatalog();
    await loadExternalPlugins();
    await loadExternalPlugins();
    expect(imports).toHaveLength(1);
  });
});

describe("extensions-changed transitions", () => {
  // The event payload IS the complete authoritative descriptor list; the
  // handler applies it directly (no re-fetch, so no out-of-order reply can
  // resurrect a disabled plugin). External discovery is startup-only.
  it("deactivates on disable: disposer, scope cleanup, unregister", async () => {
    const disposed = [];
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        const off = api.sessions.onOutput(() => {});
        api.ui.registerPanel(panel("com.example.alpha.panel"));
        return () => {
          disposed.push("plugin disposer");
          off();
        };
      },
    }));
    installAlphaCatalog({ enabled: true });
    await loadExternalPlugins();
    expect(getPlugin("com.example.alpha")).not.toBeNull();
    expect(eventListeners.get("pty-output")?.size ?? 0).toBe(1);

    // The event payload is the post-transition descriptor list itself.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    await flushMicrotasks(20);

    expect(disposed).toEqual(["plugin disposer"]);
    expect(getPlugin("com.example.alpha")).toBeNull();
    expect(eventListeners.get("pty-output")?.size ?? 0).toBe(0);
  });

  it("re-activates on re-enable (activate runs again)", async () => {
    const imports = [];
    const activations = [];
    setPluginBundleImporter(async (bundleUrl) => {
      imports.push(bundleUrl);
      return {
        activate: (api) => {
          activations.push(api.meta.pluginId);
          api.ui.registerPanel(panel("com.example.alpha.panel"));
        },
      };
    });
    installAlphaCatalog({ enabled: true });
    await loadExternalPlugins();
    expect(activations).toHaveLength(1);

    // Disable through the event payload.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();

    // Re-enable through a second event.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: true }),
    ]);
    await flushMicrotasks(20);

    expect(activations).toHaveLength(2);
    expect(imports).toHaveLength(2); // one import per activation attempt
    expect(getPlugin("com.example.alpha")).not.toBeNull();
  });

  it("discards a late activation completion after a newer disable", async () => {
    // The activation's import hangs; the event disables the plugin before it
    // resolves. The late completion must not register anything.
    const gate = deferred();
    setPluginBundleImporter(async () => {
      await gate.promise;
      return { activate: (api) => api.ui.registerPanel(panel("com.example.alpha.panel")) };
    });
    installAlphaCatalog();

    const loading = loadExternalPlugins();
    await flushMicrotasks();
    // The activation is pending on the import gate.

    // A newer transition disables the plugin while the import is in flight.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    await flushMicrotasks(20);

    // The late import resolves now. The losing attempt must discard.
    gate.resolve();
    await loading;
    await flushMicrotasks(20);

    expect(getPlugin("com.example.alpha")).toBeNull();
  });

  it("serializes rapid off/on without losing the final state", async () => {
    const activations = [];
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        activations.push(api.meta.pluginId);
        api.ui.registerPanel(panel("com.example.alpha.panel"));
      },
    }));
    installAlphaCatalog({ enabled: true });
    await loadExternalPlugins();

    // Off, then on, fired back to back without awaiting between them. The
    // events are applied in arrival order; the final one wins.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: true }),
    ]);
    await flushMicrotasks(40);

    // Whatever the interleaving, the registry reflects the last event: the
    // plugin is registered exactly once and the old registration is gone.
    const matches = listPlugins().filter(
      (plugin) => plugin.id === "com.example.alpha",
    );
    expect(matches).toHaveLength(1);
    expect(activations.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a busy-disable rejection out of the registry (authority stays with extensionState)", async () => {
    // The backend rejects the disable (operations in flight); the transition
    // never publishes an event. An event that still says enabled — or none
    // at all — must not tear the plugin down.
    setPluginBundleImporter(async () => ({
      activate: (api) => api.ui.registerPanel(panel("com.example.alpha.panel")),
    }));
    installAlphaCatalog({ enabled: true });
    await loadExternalPlugins();

    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: true }),
    ]);
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).not.toBeNull();
  });

  it("a stale startup fetch cannot resurrect a plugin an event disabled", async () => {
    // The startup fetch is slow; an event disables the plugin while the
    // fetch is in flight. The stale reply (enabled: true) must be dropped.
    const gate = deferred();
    setPluginBundleImporter(async () => ({
      activate: (api) => api.ui.registerPanel(panel("com.example.alpha.panel")),
    }));
    commandHandlers.set("list_extensions", async () => {
      await gate.promise;
      return [
        ...defaultExtensionState(),
        descriptor("com.example.alpha", { enabled: true }),
      ];
    });
    commandHandlers.set("list_external_plugins", async () => {
      await gate.promise;
      return [descriptor("com.example.alpha", { enabled: true })];
    });

    const loading = loadExternalPlugins();
    await flushMicrotasks();
    // The startup fetch is pending on the gate.

    // An event disables the plugin first.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();

    // The stale startup reply lands now: it must be dropped wholesale.
    gate.resolve();
    await loading;
    await flushMicrotasks(20);

    expect(getPlugin("com.example.alpha")).toBeNull();
  });
});

describe("activation failure containment", () => {
  it("a throwing activate releases the native listeners it armed first", async () => {
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        // Arm subscriptions, then throw: the attempt's scope disposal must
        // release both native listeners, not leak them to the next teardown.
        api.sessions.onOutput(() => {});
        api.sftp.onTransfer(() => {});
        throw new Error("activate exploded");
      },
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();
    expect(eventListeners.get("pty-output")?.size ?? 0).toBe(0);
    expect(eventListeners.get("sftp-transfer")?.size ?? 0).toBe(0);
  });

  it("calls a late-resolving user disposer exactly once after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const disposer = vi.fn();
      let resolveActivation;
      setPluginBundleImporter(async () => ({
        activate: () =>
          new Promise((resolve) => {
            resolveActivation = resolve;
          }),
      }));
      installAlphaCatalog();
      const loading = loadExternalPlugins();
      // The activation never settles within the budget.
      await vi.advanceTimersByTimeAsync(11000);
      await loading;
      expect(getPlugin("com.example.alpha")).toBeNull();

      // The activation resolves late with a disposer: it must run, once.
      resolveActivation(disposer);
      await flushMicrotasks(20);
      expect(disposer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls the user disposer on a registration-conflict failure, exactly once", async () => {
    registerBuiltinPlugins();
    const disposer = vi.fn();
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        // Conflicts with the builtin sftp panel key.
        api.ui.registerPanel(panel("sftp", 5));
        return disposer;
      },
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();
    expect(disposer).toHaveBeenCalledTimes(1);
  });
});

describe("catalog race contracts", () => {
  it("A: an enabled external is never stranded by a stale dropped fetch", async () => {
    // alpha is disabled by an event mid-startup; beta stays enabled. The
    // startup fetch (which returns BOTH enabled) is dropped by the revision
    // guard. alpha must never execute; beta must be registered after await.
    const executed = [];
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        executed.push(api.meta.pluginId);
        api.ui.registerPanel(panel(`${api.meta.pluginId}.panel`));
      },
    }));
    const gate = deferred();
    commandHandlers.set("list_extensions", async () => {
      await gate.promise;
      return [
        ...defaultExtensionState(),
        descriptor("com.example.alpha"),
        descriptor("com.example.beta"),
      ];
    });
    commandHandlers.set("list_external_plugins", async () => {
      await gate.promise;
      return [descriptor("com.example.alpha"), descriptor("com.example.beta")];
    });

    const loading = loadExternalPlugins();
    await flushMicrotasks();
    // The startup fetch is pending on the gate. An event disables alpha
    // (its payload is the complete authoritative list).
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
      descriptor("com.example.beta", { enabled: true }),
    ]);
    await flushMicrotasks(10);
    expect(getPlugin("com.example.alpha")).toBeNull();

    // The stale fetch reply (both enabled) lands now: dropped as an
    // application, but its discovery rows must survive for beta.
    gate.resolve();
    await loading;
    await flushMicrotasks(10);

    expect(executed).not.toContain("com.example.alpha");
    expect(getPlugin("com.example.alpha")).toBeNull();
    expect(getPlugin("com.example.beta")).not.toBeNull();
    expect(getPlugin("com.example.beta").panels().map((entry) => entry.id)).toEqual([
      "com.example.beta.panel",
    ]);
  });

  it("B: a disable during a pending import never calls activate", async () => {
    // The import hangs. Disable BEFORE it resolves: when the import resolves
    // later, activate must NOT be called at all.
    const gate = deferred();
    const activateCalls = [];
    setPluginBundleImporter(async () => {
      await gate.promise;
      return {
        activate: (api) => {
          activateCalls.push(api.meta.pluginId);
          api.ui.registerPanel(panel("com.example.alpha.panel"));
        },
      };
    });
    installAlphaCatalog();

    const loading = loadExternalPlugins();
    await flushMicrotasks(10);
    // The activation attempt is pending on the import gate.

    // Disable BEFORE the import resolves.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    await flushMicrotasks(10);

    // The import resolves now: activate must NOT be called.
    gate.resolve();
    await loading;
    await flushMicrotasks(20);

    expect(activateCalls).toEqual([]);
    expect(getPlugin("com.example.alpha")).toBeNull();
  });

  it("B: a disable during a pending activate releases armed listeners immediately and refuses the old API", async () => {
    // The import resolves instantly; activate arms a subscription and then
    // hangs. Disable must release the native listener WITHOUT waiting for
    // the activation promise (not after the 10s budget), and the old API
    // must refuse further use.
    let armedApi = null;
    const gate = deferred();
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        armedApi = api;
        api.sessions.onOutput(() => {});
        return gate.promise;
      },
    }));
    installAlphaCatalog();

    const loading = loadExternalPlugins();
    await flushMicrotasks(10);
    // activate ran and armed the listener; the activation is pending.
    expect(armedApi).not.toBeNull();
    await flushMicrotasks(10);
    expect(eventListeners.get("pty-output")?.size ?? 0).toBe(1);

    // Disable: the listener releases NOW (not when the promise settles).
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: false }),
    ]);
    await flushMicrotasks(10);
    expect(eventListeners.get("pty-output")?.size ?? 0).toBe(0);

    // The old facade refuses further operations (scope disposed).
    await expect(armedApi.sessions.list()).rejects.toThrow(
      /the API scope is disposed/,
    );

    // The pending activation resolves later: nothing publishes.
    gate.resolve(null);
    await loading;
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();
  });

  it("C: an event-started activation during startup is awaited by load", async () => {
    // An event fires while the startup queue is draining, starting a gated
    // activation. loadExternalPlugins must await THAT attempt too: it must
    // not resolve while the import is still pending.
    const gate = deferred();
    setPluginBundleImporter(async () => {
      await gate.promise;
      return {
        activate: (api) => api.ui.registerPanel(panel("com.example.alpha.panel")),
      };
    });
    commandHandlers.set("list_extensions", async () => [
      ...defaultExtensionState(),
      descriptor("com.example.alpha"),
    ]);
    commandHandlers.set("list_external_plugins", async () => [
      descriptor("com.example.alpha"),
    ]);

    const loading = loadExternalPlugins();
    await flushMicrotasks(10);
    // An event arrives while the startup queue is draining: the attempt it
    // starts must be tracked by the startup await.
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha", { enabled: true }),
    ]);
    // The import is still gated: loadExternalPlugins must NOT resolve yet.
    let settled = false;
    void loading.then(() => {
      settled = true;
    });
    await flushMicrotasks(20);
    expect(settled).toBe(false);
    expect(getPlugin("com.example.alpha")).toBeNull();

    gate.resolve();
    await loading;
    expect(getPlugin("com.example.alpha")).not.toBeNull();
    expect(getPlugin("com.example.alpha").panels().map((entry) => entry.id)).toEqual([
      "com.example.alpha.panel",
    ]);
  });

  it("D: concurrent loadExternalPlugins callers await the same run", async () => {
    const gate = deferred();
    setPluginBundleImporter(async () => {
      await gate.promise;
      return {
        activate: (api) => api.ui.registerPanel(panel("com.example.alpha.panel")),
      };
    });
    installAlphaCatalog();

    const first = loadExternalPlugins();
    const second = loadExternalPlugins();
    // Both callers are waiting on the same in-flight run.
    let registeredWhenSecondResolved = false;
    void second.then(() => {
      registeredWhenSecondResolved = getPlugin("com.example.alpha") !== null;
    });
    await flushMicrotasks(10);
    gate.resolve();
    await Promise.all([first, second]);
    // The second caller resolved AFTER the activation settled: it observed
    // the registered plugin, not a premature empty registry.
    expect(registeredWhenSecondResolved).toBe(true);
    expect(getPlugin("com.example.alpha")).not.toBeNull();
  });

  it("D: a settled activation clears its budget timers", async () => {
    vi.useFakeTimers();
    try {
      setPluginBundleImporter(async () => ({
        activate: (api) => {
          api.ui.registerPanel(panel("com.example.alpha.panel"));
        },
      }));
      installAlphaCatalog();
      const loading = loadExternalPlugins();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      // The activation settled: its budget timer was cleared. Advancing the
      // clock past the budget must not unregister or disturb anything.
      await vi.advanceTimersByTimeAsync(11000);
      expect(getPlugin("com.example.alpha")).not.toBeNull();
      expect(getPlugin("com.example.alpha").panels()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("post-publish contribution changes", () => {
  it("a post-publish registerPanel updates the live registry panels and notifies consumers", async () => {
    let lateRegister = null;
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        api.ui.registerPanel(panel("com.example.alpha.panel"));
        // Kept for after publication.
        lateRegister = () => api.ui.registerPanel(panel("com.example.alpha.panel.two", 31));
      },
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    const plugin = getPlugin("com.example.alpha");
    expect(plugin.panels()).toHaveLength(1);

    const seen = [];
    const unsubscribe = subscribeRegistry(() => seen.push(getRegistryVersion()));
    const before = getRegistryVersion();

    lateRegister();
    expect(plugin.panels()).toHaveLength(2);
    expect(plugin.panels().map((entry) => entry.id)).toEqual([
      "com.example.alpha.panel",
      "com.example.alpha.panel.two",
    ]);
    // The consumer notification fired for the content-only change: not just
    // once at publish time.
    expect(seen.length).toBeGreaterThan(0);
    expect(getRegistryVersion()).toBeGreaterThan(before);
    unsubscribe();
  });

  it("a post-publish unregister updates the live registry panels", async () => {
    let removePanel = null;
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        removePanel = api.ui.registerPanel(panel("com.example.alpha.panel"));
      },
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    const plugin = getPlugin("com.example.alpha");
    expect(plugin.panels()).toHaveLength(1);

    removePanel();
    expect(plugin.panels()).toHaveLength(0);
  });

  it("the controller hook identity is fixed at publish", async () => {
    let registerController = null;
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        registerController = api.ui.registerController;
        registerController(() => ({ version: 1 }));
      },
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    const plugin = getPlugin("com.example.alpha");
    const first = plugin.createController;
    expect(typeof first).toBe("function");

    // A second registration is refused while the first stands: swapping the
    // hook in place would change hook order, which the contract forbids.
    registerController(() => ({ version: 2 }));
    expect(plugin.createController).toBe(first);
  });
});

describe("runtime install and uninstall", () => {
  // Before removal was a runtime operation, a vanished plugin was retired on
  // the startup path only. An uninstall now emits `extensions-changed`, and
  // the event path must retire too — otherwise the removed plugin's toolbar
  // button and panel stay on screen with no way to get rid of them.
  it("retires a plugin that vanished from the catalog, contributions included", async () => {
    const disposed = [];
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        api.ui.registerPanel(panel("com.example.alpha.panel"));
        return () => disposed.push("plugin disposer");
      },
    }));
    installAlphaCatalog();
    await loadExternalPlugins();
    expect(getPlugin("com.example.alpha")).not.toBeNull();

    // Uninstall: the backend re-scans and emits the merged catalog, which no
    // longer lists the plugin. Discovery still answers with a stale row for
    // it, which must not resurrect it.
    fireExtensionsChanged([...defaultExtensionState()]);
    await flushMicrotasks(20);

    expect(disposed).toEqual(["plugin disposer"]);
    expect(getPlugin("com.example.alpha")).toBeNull();
    expect(listPlugins().filter((plugin) => plugin.builtin === false)).toEqual([]);
  });

  it("does not resurrect a removed plugin from the discovery cache", async () => {
    setPluginBundleImporter(async () => ({ activate: () => {} }));
    installAlphaCatalog();

    // The catalog lists the plugin but the discovery reply predates its
    // removal: the catalog decides which bundles exist, so applying the
    // catalog must not activate it.
    commandHandlers.set("list_external_plugins", async () => [
      descriptor("com.example.alpha"),
    ]);
    await loadExternalPlugins();
    expect(getPlugin("com.example.alpha")).not.toBeNull();

    // A later event drops it from the catalog; discovery still returns the
    // stale row.
    fireExtensionsChanged([...defaultExtensionState()]);
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();

    // And it stays gone on the follow-up application the handler runs once
    // discovery has been re-read.
    await flushMicrotasks(20);
    expect(getPlugin("com.example.alpha")).toBeNull();
  });

  it("activates a plugin installed at runtime once discovery knows its bundle", async () => {
    const activations = [];
    setPluginBundleImporter(async () => ({
      activate: (api) => {
        activations.push(api.meta.pluginId);
        api.ui.registerPanel(panel("com.example.alpha.panel"));
      },
    }));
    // Nothing installed yet.
    await loadExternalPlugins();
    expect(getPlugin("com.example.alpha")).toBeNull();

    // Install: the event payload lists the plugin, and discovery now answers
    // with its bundle URL.
    installAlphaCatalog();
    fireExtensionsChanged([
      ...defaultExtensionState(),
      descriptor("com.example.alpha"),
    ]);
    await flushMicrotasks(20);

    expect(activations).toEqual(["com.example.alpha"]);
    expect(getPlugin("com.example.alpha")).not.toBeNull();
    expect(getPlugin("com.example.alpha").panels()).toHaveLength(1);
  });
});
