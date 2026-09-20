// The plugin API facade (API v1).
//
// `createPluginApi(pluginId, { host })` returns the public object handed to
// `activate(api)`. The facade is a contract, not a sandbox: it exposes no
// `invoke`, no raw `listen`, no event envelopes, no PTY input and no
// trust-write. Every native operation routes through the private host bridge
// (`src/lib/plugin-host.js`, injected by the loader) as
// `{ extensionId, command, args }` over `invoke_extension_api`, so the
// backend holds the caller extension's lease across each operation.
//
// All subscriptions and `ui` registrations are owned by one activation
// scope: `disposeApiScope(api)` releases them. The loader calls it on
// disable (after the plugin's own disposer) so a plugin that leaked a
// subscription cannot outlive its activation.

import * as react from "react";

export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Storage: JSON under a per-plugin prefix.
//
// The prefix encodes both the plugin id and the key so `id="a:b"` with
// `key="b:c"` can never collide with `id="a"` and `key="b:c"` (or any other
// split of the same concatenated string): each component is
// percent-encoded with its delimiters unambiguous. This is a namespacing
// contract, not a security boundary. Existing builtin host preference keys
// (`eshell:sftp-download-dir`, ...) are untouched: they are compatibility
// settings owned by the builtin plugins, not plugin storage.
// ---------------------------------------------------------------------------
const encodeStoragePart = (value) =>
  encodeURIComponent(String(value ?? "")).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const storageKeyFor = (pluginId, key) =>
  `eshell:plugin:${encodeStoragePart(pluginId)}:${encodeStoragePart(key)}`;

const readStorageJson = (pluginId, key) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKeyFor(pluginId, key));
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeStorageJson = (pluginId, key, value) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(storageKeyFor(pluginId, key), JSON.stringify(value ?? null));
  } catch {
    // A full or blocked localStorage is not worth failing a plugin over.
  }
};

const removeStorageJson = (pluginId, key) => {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(storageKeyFor(pluginId, key));
  } catch {
    // Ignore.
  }
};

// ---------------------------------------------------------------------------
// Activation scope: owns every subscription and UI registration an API
// object hands out. Disposable exactly once; late native unlisten resolves
// are ignored after dispose.
//
// The scope is a lifecycle contract, not an authentication boundary: every
// brokered operation and every new registration checks it, so an API whose
// activation failed, timed out or was disabled can neither keep issuing
// backend operations through a stale facade nor resurrect registrations.
// A late `track` on a disposed scope runs its disposer immediately — a
// subscription registering after dispose is released, never admitted.
// ---------------------------------------------------------------------------
const createScope = () => {
  const disposers = new Set();
  let disposed = false;

  const runDisposer = (disposer) => {
    try {
      disposer();
    } catch (error) {
      console.warn("[plugin-api] scope cleanup failed", error);
    }
  };

  return {
    get disposed() {
      return disposed;
    },
    /** Registers one cleanup action; returns its sync remover. A call on a
     *  disposed scope runs the disposer immediately and admits nothing. */
    track(disposer) {
      if (disposed) {
        runDisposer(disposer);
        return () => {};
      }
      disposers.add(disposer);
      let removed = false;
      return () => {
        if (removed || disposed) {
          return;
        }
        removed = true;
        disposers.delete(disposer);
        runDisposer(disposer);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // Copy: a disposer that (incorrectly) unregisters itself mid-dispose
      // must not mutate the iteration.
      for (const disposer of [...disposers]) {
        runDisposer(disposer);
      }
      disposers.clear();
    },
  };
};

/**
 * Disposes one activation scope's API-owned resources: every event
 * subscription and UI registration the API object handed out. The loader
 * calls this on disable, after the plugin's own disposer; a plugin that
 * already unregistered everything makes this a no-op.
 */
export const disposeApiScope = (apiObject) => {
  apiObject?.[SCOPE]?.scope?.dispose();
};

/** True when one API object's activation scope has been disposed. */
export const isApiScopeDisposed = (apiObject) =>
  Boolean(apiObject?.[SCOPE]?.scope?.disposed);

const SCOPE = Symbol("pluginApiScope");

// ---------------------------------------------------------------------------
// Event subscriptions.
//
// Contract: the returned unsubscribe is synchronous and idempotent even
// though native `listen()` registration is asynchronous. A second call after
// a pending registration is a no-op; a registration that resolves after
// dispose/unsubscribe is unlistened immediately and dropped. Subscriptions
// register only on explicit `on*()` — there is no ambient feed, and
// `pty-output` (terminal raw output) is never exposed verbatim:
// `sessions.onOutput` unwraps and validates it first.
// ---------------------------------------------------------------------------
const createEventSubscription = ({
  scope,
  host,
  eventName,
  validatePayload,
  subscriber,
  options = {},
}) => {
  // A disposed activation admits no new subscriptions: the pending native
  // listener (were one started) would be released on resolve, so refuse up
  // front instead of arming a doomed registration.
  if (scope.disposed) {
    console.warn(`[plugin-api] ${eventName} subscription ignored: the API scope is disposed`);
    return () => {};
  }
  let unsubscribe = null;
  let pending = false;
  let closed = false;
  const { sessionId: filterSessionId } = options;

  const handleEvent = (event) => {
    if (closed) {
      return;
    }
    const payload = event?.payload;
    const unwrapped = validatePayload ? validatePayload(payload) : payload;
    if (unwrapped === null || unwrapped === undefined) {
      return;
    }
    if (
      filterSessionId !== undefined &&
      filterSessionId !== null &&
      String(unwrapped.sessionId ?? "") !== String(filterSessionId)
    ) {
      return;
    }
    try {
      subscriber(unwrapped);
    } catch (error) {
      console.warn("[plugin-api] event subscriber failed", error);
    }
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  // Native registration is async; the scope tracks the eventual unlisten so
  // dispose during the pending window still releases it.
  pending = true;
  host
    .listenPluginEvent(eventName, handleEvent)
    .then((unlisten) => {
      pending = false;
      if (closed) {
        // Unsubscribed (or scope disposed) while registering: release now.
        try {
          unlisten?.();
        } catch (error) {
          console.warn("[plugin-api] late listener release failed", error);
        }
        return;
      }
      unsubscribe = typeof unlisten === "function" ? unlisten : null;
    })
    .catch((error) => {
      pending = false;
      if (!closed) {
        console.warn(`[plugin-api] failed to bind ${eventName}`, error);
      }
    });

  const syncUnsubscribe = scope.track(() => {
    closed = true;
    if (!pending) {
      unsubscribe?.();
      unsubscribe = null;
    }
    // If still pending, the resolution branch above releases the listener.
  });
  return () => {
    syncUnsubscribe();
    close();
  };
};

// Payload validators. Invalid payloads are dropped, never passed through.
const validSessionId = (payload) =>
  payload && typeof payload === "object" && String(payload.sessionId || "").trim()
    ? String(payload.sessionId).trim()
    : null;

const validateOutputPayload = (payload) => {
  // `pty-output`: { sessionId, chunk } — chunk must be a nonempty string.
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const sessionId = validSessionId(payload);
  const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
  if (!sessionId || !chunk) {
    return null;
  }
  return { sessionId, chunk };
};

const validateClosedPayload = (payload) => {
  // `pty-closed`: { sessionId, reason? }.
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const sessionId = validSessionId(payload);
  if (!sessionId) {
    return null;
  }
  return { sessionId, reason: typeof payload.reason === "string" ? payload.reason : "" };
};

const validateTransferPayload = (payload) => {
  // `sftp-transfer`: the backend DTO, camelCase. `transferId` is the
  // discriminator; everything else passes through for the subscriber to
  // interpret (the existing normalizer stays the builtin's own concern).
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const transferId = String(payload.transferId || "").trim();
  if (!transferId) {
    return null;
  }
  const sessionId = validSessionId(payload);
  if (!sessionId) {
    return null;
  }
  return { ...payload, transferId, sessionId };
};

// ---------------------------------------------------------------------------
// UI contributions.
//
// The loader stages these, then publishes the registry shape atomically (see
// `loader.js`); the API only records them and hands the loader the staged
// lists plus per-registration removers. Globally unique panel keys/IDs
// (including the reserved `draft`) and one controller per plugin are
// validated at publish time by the loader, which sees the whole registry.
// ---------------------------------------------------------------------------
const RESERVED_PANEL_KEYS = new Set(["draft"]);

const validPanelContribution = (panel) => {
  if (!panel || typeof panel !== "object") {
    return null;
  }
  const id = String(panel.id || "").trim();
  if (!id || typeof panel.render !== "function") {
    return null;
  }
  const key = String(panel.key || id).trim() || id;
  if (RESERVED_PANEL_KEYS.has(key) || RESERVED_PANEL_KEYS.has(id)) {
    return null;
  }
  return {
    id,
    key,
    order: Number.isFinite(Number(panel.order)) ? Number(panel.order) : 0,
    title: panel.title === undefined ? undefined : String(panel.title),
    // Opt-in: a panel starts hidden unless it asks to be shown. Installing a
    // plugin must not rearrange the user's dock — a plugin that opened its
    // panel on install would do so on every launch, since visibility is not
    // persisted. `defaultVisible: true` is the explicit request to appear.
    defaultVisible: panel.defaultVisible === true,
    render: panel.render,
  };
};

const validToolbarContribution = (item) => {
  if (!item || typeof item !== "object") {
    return null;
  }
  const id = String(item.id || "").trim();
  if (!id) {
    return null;
  }
  const key = String(item.key || id).trim() || id;
  if (RESERVED_PANEL_KEYS.has(key) || RESERVED_PANEL_KEYS.has(id)) {
    return null;
  }
  return {
    id,
    key,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
    panelId: item.panelId === undefined ? undefined : String(item.panelId),
    label: item.label === undefined ? undefined : String(item.label),
    icon: item.icon === undefined ? undefined : item.icon,
    onClick: typeof item.onClick === "function" ? item.onClick : undefined,
  };
};

/**
 * Creates the API v1 facade for one plugin.
 *
 * `options.host` is the private bridge (defaults to the real one from
 * `src/lib/plugin-host.js`); it is closed over, never exposed on the
 * returned object. `options.getContext` supplies `ui.getContext()`'s live
 * snapshot (the loader injects the workbench snapshot getter; empty object
 * before workbench mount).
 */
export function createPluginApi(pluginId, options = {}) {
  const id = String(pluginId || "").trim();
  if (!id) {
    throw new Error("createPluginApi requires a plugin id");
  }
  const host = options.host;
  if (!host || typeof host.invokeExtensionApi !== "function") {
    throw new Error("createPluginApi requires a host bridge");
  }

  const scope = createScope();
  const getContext = () => options.getContext?.() || {};

  // One brokered call. `command`/`args` use the existing Tauri names/shapes:
  // most commands take `{ input: { ... } }`; `get_cached_server_status` is
  // the app's legacy `{ sessionId }`; the no-argument commands take `{}`.
  // The pickers take `{ title?, defaultPath? }` per the broker contract.
  //
  // The scope guard is a lifecycle contract: a disposed activation (failed,
  // timed out, disabled) cannot keep issuing backend operations through its
  // stale facade. This is not authentication — same-context code can bypass
  // the facade — but the facade itself honors the activation's lifetime.
  // The guard rejects the returned promise (never a synchronous throw), so
  // every facade method stays awaitable under every lifecycle state.
  const scopeDisposedError = () =>
    new Error(
      `[plugin ${id}] the API scope is disposed; this activation is no longer live`,
    );

  const guardScope = () => {
    if (scope.disposed) {
      return Promise.reject(scopeDisposedError());
    }
    return null;
  };

  const callInput = (command, input) => {
    const guarded = guardScope();
    if (guarded) {
      return guarded;
    }
    return host.invokeExtensionApi({ extensionId: id, command, args: { input } });
  };

  const callArg = (command, args) => {
    const guarded = guardScope();
    if (guarded) {
      return guarded;
    }
    return host.invokeExtensionApi({ extensionId: id, command, args });
  };

  const logPrefix = `[plugin ${id}]`;
  const log = {
    info: (...args) => console.info(logPrefix, ...args),
    warn: (...args) => console.warn(logPrefix, ...args),
    error: (...args) => console.error(logPrefix, ...args),
  };

  // --- UI staging ---------------------------------------------------------
  const stagedPanels = new Map(); // panel id -> contribution
  const stagedToolbar = new Map(); // item id -> contribution
  let stagedController = null;

  // Fired on every contribution change (add or removal), including after
  // the loader published the plugin: the registry's `panels()`/`toolbar()`
  // closures read this scope's live lists, so a post-publish register or
  // unregister changes what consumers resolve. The loader injects the
  // notifier (it owns the registry transition); nothing fires before
  // publication, when only the loader is watching.
  const notifyContributionsChanged = () => {
    if (typeof options.onContributionsChanged === "function") {
      try {
        options.onContributionsChanged();
      } catch (error) {
        console.warn("[plugin-api] contribution change notifier failed", error);
      }
    }
  };

  const registerPanel = (panel) => {
    if (scope.disposed) {
      log.warn("registerPanel ignored: the API scope is disposed");
      return () => {};
    }
    const contribution = validPanelContribution(panel);
    if (!contribution) {
      log.warn("registerPanel ignored an invalid panel");
      return () => {};
    }
    if (stagedPanels.has(contribution.id)) {
      log.warn(`registerPanel ignored a duplicate panel id: ${contribution.id}`);
      return () => {};
    }
    stagedPanels.set(contribution.id, contribution);
    notifyContributionsChanged();
    return scope.track(() => {
      stagedPanels.delete(contribution.id);
      notifyContributionsChanged();
    });
  };

  const registerToolbar = (item) => {
    if (scope.disposed) {
      log.warn("registerToolbar ignored: the API scope is disposed");
      return () => {};
    }
    const contribution = validToolbarContribution(item);
    if (!contribution) {
      log.warn("registerToolbar ignored an invalid item");
      return () => {};
    }
    if (stagedToolbar.has(contribution.id)) {
      log.warn(`registerToolbar ignored a duplicate item id: ${contribution.id}`);
      return () => {};
    }
    stagedToolbar.set(contribution.id, contribution);
    notifyContributionsChanged();
    return scope.track(() => {
      stagedToolbar.delete(contribution.id);
      notifyContributionsChanged();
    });
  };

  const registerController = (hook) => {
    if (scope.disposed) {
      log.warn("registerController ignored: the API scope is disposed");
      return () => {};
    }
    if (typeof hook !== "function") {
      log.warn("registerController ignored a non-function");
      return () => {};
    }
    if (stagedController) {
      log.warn("registerController ignored a second controller");
      return () => {};
    }
    stagedController = hook;
    notifyContributionsChanged();
    let removed = false;
    const remover = scope.track(() => {
      if (!removed) {
        removed = true;
        stagedController = null;
        notifyContributionsChanged();
      }
    });
    return () => {
      if (removed) {
        return;
      }
      remover();
    };
  };

  // Host React instance. `eshell.react` is the host React — plugins use
  // `eshell.react.createElement`; no bare `react` import, no second bundle.
  const reactNamespace = {
    ...react,
    createElement: react.createElement,
    useState: react.useState,
    useEffect: react.useEffect,
    useMemo: react.useMemo,
    useRef: react.useRef,
    useCallback: react.useCallback,
    useReducer: react.useReducer,
    useContext: react.useContext,
    Fragment: react.Fragment,
  };

  const pluginApi = {
    sessions: {
      list: () => callArg("list_shell_sessions", {}),
      open: (configId, requestId = null) =>
        callInput("open_shell_session", { configId, requestId }),
      close: (sessionId) => callInput("close_shell_session", { sessionId }),
      execute: (sessionId, command) =>
        callInput("execute_shell_command", { sessionId, command }),
      onOutput: (subscriber, options = {}) =>
        createEventSubscription({
          scope,
          host,
          eventName: "pty-output",
          validatePayload: validateOutputPayload,
          subscriber,
          options,
        }),
      onClosed: (subscriber, options = {}) =>
        createEventSubscription({
          scope,
          host,
          eventName: "pty-closed",
          validatePayload: validateClosedPayload,
          subscriber,
          options,
        }),
      onHostKeyPrompt: (subscriber) => {
        // No native event: an in-process readonly signal from the workbench
        // TOFU prompt path. No reply channel, no trust write. A disposed
        // activation admits no new observers.
        if (scope.disposed || typeof subscriber !== "function") {
          return () => {};
        }
        let closed = false;
        const remover = host.addHostKeyPromptListener?.((challenge) => {
          if (!closed && challenge && typeof challenge === "object") {
            try {
              subscriber(challenge);
            } catch (error) {
              console.warn("[plugin-api] host-key prompt subscriber failed", error);
            }
          }
        });
        return scope.track(() => {
          closed = true;
          remover?.();
        });
      },
    },
    sftp: {
      listDir: (sessionId, path) => callInput("sftp_list_dir", { sessionId, path }),
      readFile: (sessionId, path) => callInput("sftp_read_file", { sessionId, path }),
      writeFile: (sessionId, path, content) =>
        callInput("sftp_write_file", { sessionId, path, content }),
      createFile: (sessionId, path) => callInput("sftp_create_file", { sessionId, path }),
      createDirectory: (sessionId, path) =>
        callInput("sftp_create_directory", { sessionId, path }),
      deleteEntry: (sessionId, path, entryType) =>
        callInput("sftp_delete_entry", { sessionId, path, entryType }),
      renameEntry: (sessionId, path, newName) =>
        callInput("sftp_rename_entry", { sessionId, path, newName }),
      uploadLocalFile: (sessionId, remotePath, localPath, transferId, localName = null) =>
        callInput("sftp_upload_local_file_with_progress", {
          sessionId,
          remotePath,
          localPath,
          transferId,
          localName,
        }),
      downloadToLocal: (sessionId, remotePath, localDir, transferId) =>
        callInput("sftp_download_file_to_local", {
          sessionId,
          remotePath,
          localDir,
          transferId,
        }),
      cancelTransfer: (transferId) =>
        callInput("sftp_cancel_transfer", { transferId }),
      defaultDownloadDir: () => callArg("sftp_default_download_dir", {}),
      selectUploadFile: (pickerOptions) =>
        callArg("select_upload_file", normalizePickerOptions(pickerOptions)).then(
          normalizePickerResult,
        ),
      selectDownloadDir: (pickerOptions) =>
        callArg("select_download_dir", normalizePickerOptions(pickerOptions)).then(
          normalizePickerResult,
        ),
      onTransfer: (subscriber, options = {}) =>
        createEventSubscription({
          scope,
          host,
          eventName: "sftp-transfer",
          validatePayload: validateTransferPayload,
          subscriber,
          options,
        }),
    },
    status: {
      fetch: (sessionId, nic) =>
        callInput("fetch_server_status", { sessionId, selectedInterface: nic }),
      // The app's legacy shape: `{ sessionId }` at the top level, not
      // `{ input: { ... } }` — preserved exactly (see `tauri-api.js`).
      cached: (sessionId) => callArg("get_cached_server_status", { sessionId }),
    },
    // Re-read config files the user (or this plugin) edited on disk, so a
    // change takes effect without restarting the app. Read-only: it returns
    // per-file outcomes, never the file contents, so a plugin cannot use it
    // to read SSH credentials.
    config: {
      /** Reload one file (`sshConfigs`, `acpAgents`, `scripts`,
       *  `aiProfiles`, `agentContext`), or all of them when omitted. */
      reload: (file) => callInput("reload_config", file ? { file } : {}),
      /** The reloadable files, as `{ file, pathHint }` rows. */
      list: () => callArg("list_reloadable_configs", {}),
    },
    ui: {
      registerPanel,
      registerToolbar,
      registerController,
      getContext,
    },
    storage: {
      // Reads stay available after dispose (read-only, harmless, and useful
      // for cleanup diagnostics); WRITES are refused on a disposed scope so
      // a stale activation's late async callback cannot overwrite a newer
      // activation's persisted values under the same plugin id after a
      // rapid off/on. This is misuse prevention, not a sandbox: raw
      // localStorage remains reachable from the same context.
      //
      // The plugin's own disposer still writes legally: every timely
      // teardown path runs it while the scope is still live (see the
      // loader); only the late-after-timeout path cannot.
      get: (key) => readStorageJson(id, key),
      set: (key, value) => {
        if (scope.disposed) {
          log.warn("storage.set ignored: the API scope is disposed");
          return;
        }
        writeStorageJson(id, key, value);
      },
      remove: (key) => {
        if (scope.disposed) {
          log.warn("storage.remove ignored: the API scope is disposed");
          return;
        }
        removeStorageJson(id, key);
      },
    },
    log,
    meta: {
      pluginId: id,
      apiVersion: PLUGIN_API_VERSION,
    },
    // The host React instance. Same module namespace the app uses; plugins
    // never bundle their own React (see `examples/hello-plugin`).
    react: reactNamespace,
  };

  // Private handle for the loader: staged contributions and the scope.
  // Symbol-keyed so a plugin enumerating its own API object cannot reach the
  // host bridge, the raw staged maps, or the scope.
  Object.defineProperty(pluginApi, SCOPE, {
    value: {
      scope,
      listPanels: () => [...stagedPanels.values()],
      listToolbar: () => [...stagedToolbar.values()],
      getController: () => stagedController,
    },
    enumerable: false,
    configurable: false,
  });

  return pluginApi;
}

// Pickers accept the plan's `defaultPath` string, or an options object with
// `{ title?, defaultPath? }`; both reach the broker as the same args shape.
const normalizePickerOptions = (pickerOptions) => {
  if (pickerOptions === null || pickerOptions === undefined) {
    return {};
  }
  if (typeof pickerOptions === "string") {
    return { defaultPath: pickerOptions };
  }
  if (typeof pickerOptions !== "object") {
    return {};
  }
  const options = {};
  if (typeof pickerOptions.title === "string" && pickerOptions.title.trim()) {
    options.title = pickerOptions.title;
  }
  if (typeof pickerOptions.defaultPath === "string" && pickerOptions.defaultPath.trim()) {
    options.defaultPath = pickerOptions.defaultPath;
  }
  return options;
};

const normalizePickerResult = (result) => {
  if (typeof result === "string" && result.trim()) {
    return result;
  }
  return null;
};

export { SCOPE as PLUGIN_API_SCOPE };
