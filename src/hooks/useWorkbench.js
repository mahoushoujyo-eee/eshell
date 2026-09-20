import { useCallback, useMemo, useRef, useState } from "react";
import {
  DEFAULT_WALLPAPER,
  EMPTY_SCRIPT,
  EMPTY_SSH,
  normalizeWallpaperSelection,
} from "../constants/workbench";
import { formatBytes } from "../utils/format";
import { toErrorMessage } from "./workbench/errors";
import { useWorkbenchEffects } from "./workbench/effects";
import { useWorkbenchOperations } from "./workbench/operations";
import { emitHostKeyPrompt } from "../lib/plugin-host";
import {
  SFTP_EXTENSION_ID,
  STATUS_EXTENSION_ID,
  getPlugin,
  registerBuiltinPlugins,
  setPluginHostContext,
  useExtensionState,
  useSftpController,
  useStatusController,
} from "../plugins";
import { usePanelVisibility } from "../plugins/runtime/usePanelVisibility";
import { usePluginControllerHosts } from "../plugins/runtime/usePluginControllerHosts";

// Builtin plugins register once per module evaluation, in manifest order
// (sftp, then status). Done at module scope (not in the hook) so remounts
// cannot double-register.
registerBuiltinPlugins();

export function useWorkbench() {
  const MAX_UI_NOTICES = 4;
  const DEFAULT_NOTICE_TTL_MS = 5200;

  // ---- Shared workbench state (not plugin-owned) ---------------------------
  const [theme, setTheme] = useState("light");
  const [wallpaper, setWallpaper] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_WALLPAPER;
    }

    try {
      const raw = window.localStorage.getItem("eshell:terminal-wallpaper");
      return raw ? normalizeWallpaperSelection(JSON.parse(raw)) : DEFAULT_WALLPAPER;
    } catch {
      return DEFAULT_WALLPAPER;
    }
  });
  // ---- Extension state (plugins) -------------------------------------------
  // Enabled flags for the sftp / server-monitor plugins, discovered through
  // the shared manifest. Defaults to everything enabled, so the pre-plugin UI
  // is unchanged until a toggle lands.
  const { extensions, setExtensionEnabled, isEnabled } = useExtensionState();
  const sftpEnabled = isEnabled(SFTP_EXTENSION_ID);
  const statusEnabled = isEnabled(STATUS_EXTENSION_ID);

  // ---- Panel visibility ----------------------------------------------------
  // One generic map keyed by panel key; the old showX/setShowX keys below are
  // compat adapters over the same map, so every existing consumer (and the
  // pre-plugin defaults: sftp / status / draft hidden) is unchanged. External
  // panels that explicitly asked for it (`defaultVisible: true`) appear on
  // install through this hook; the rest start hidden.
  const {
    visibility: panelVisibility,
    showPanel,
    hidePanel,
    togglePanel,
    setPanelVisible,
  } = usePanelVisibility(extensions);
  const showSftpPanel = panelVisibility.sftp === true;
  const showStatusPanel = panelVisibility.status === true;
  const showCommandDraftPanel = panelVisibility.draft === true;
  const setShowSftpPanel = useCallback(
    (value) =>
      setPanelVisible("sftp", typeof value === "function" ? value(showSftpPanel) : value),
    [setPanelVisible, showSftpPanel],
  );
  const setShowStatusPanel = useCallback(
    (value) =>
      setPanelVisible("status", typeof value === "function" ? value(showStatusPanel) : value),
    [setPanelVisible, showStatusPanel],
  );
  const setShowCommandDraftPanel = useCallback(
    (value) =>
      setPanelVisible("draft", typeof value === "function" ? value(showCommandDraftPanel) : value),
    [setPanelVisible, showCommandDraftPanel],
  );
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uiNotices, setUiNotices] = useState([]);
  const [hostKeyTrustPrompt, setHostKeyTrustPrompt] = useState(null);
  const [kiPrompt, setKiPrompt] = useState(null);

  const [sshConfigs, setSshConfigs] = useState([]);
  const [sshForm, setSshForm] = useState(EMPTY_SSH);

  const [scripts, setScripts] = useState([]);
  const [scriptForm, setScriptForm] = useState(EMPTY_SCRIPT);

  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [logs, setLogs] = useState({});
  // Sessions whose PTY died (keyed by session id → disconnect reason); the
  // terminal renders a non-interactive overlay with a reconnect button.
  const [disconnectedSessions, setDisconnectedSessions] = useState({});
  const [commandDraft, setCommandDraft] = useState("");

  // Shared cross-plugin refs. The PTY input sender and the reconnect bookkeeping
  // belong to the session layer, not to any single plugin.
  const reconnectingSessionsRef = useRef(new Map());
  const closingSessionsRef = useRef(new Set());
  const ptyInputSenderRef = useRef(null);
  const onErrorRef = useRef(() => {});
  const runWithSessionReconnectRef = useRef(null);

  const activeSession = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const dismissUiNotice = useCallback((noticeId) => {
    if (!noticeId) {
      return;
    }
    setUiNotices((prev) => prev.filter((item) => item.id !== noticeId));
  }, []);

  const pushUiNotice = useCallback(
    (err, options = {}) => {
      const rawMessage = toErrorMessage(err);
      const message =
        typeof rawMessage === "string"
          ? rawMessage.trim()
          : String(rawMessage || "").trim();
      if (!message) {
        return "";
      }

      const explicitTone = options.tone;
      const tone =
        explicitTone === "warning" ||
        explicitTone === "info" ||
        explicitTone === "success" ||
        explicitTone === "danger"
          ? explicitTone
          : /^warning/i.test(message)
            ? "warning"
            : "danger";
      const requestedTtl = Number(options.ttlMs);
      const ttlMs =
        Number.isFinite(requestedTtl) && requestedTtl >= 0
          ? requestedTtl
          : DEFAULT_NOTICE_TTL_MS;
      const noticeId =
        globalThis.crypto?.randomUUID?.() ||
        `notice-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      setUiNotices((prev) => {
        const next = [{ id: noticeId, tone, message, ttlMs }, ...prev];
        return next.slice(0, MAX_UI_NOTICES);
      });
      return noticeId;
    },
    [DEFAULT_NOTICE_TTL_MS, MAX_UI_NOTICES],
  );

  const runBusy = useCallback(async (text, action) => {
    setBusy(text);
    setError("");
    try {
      return await action();
    } finally {
      setBusy("");
    }
  }, []);

  const hostKeyTrustResolverRef = useRef(null);

  const requestHostKeyTrust = useCallback((challenge) => {
    if (hostKeyTrustResolverRef.current) {
      hostKeyTrustResolverRef.current(false);
    }
    // Read-only TOFU observation for plugins (`sessions.onHostKeyPrompt`):
    // the challenge passes through as presented; subscribers cannot reply,
    // and no password or trust decision is ever exposed. The workbench still
    // resolves trust itself.
    emitHostKeyPrompt(challenge);
    return new Promise((resolve) => {
      hostKeyTrustResolverRef.current = resolve;
      setHostKeyTrustPrompt(challenge);
    });
  }, []);

  const resolveHostKeyTrust = useCallback((accepted) => {
    const resolver = hostKeyTrustResolverRef.current;
    hostKeyTrustResolverRef.current = null;
    setHostKeyTrustPrompt(null);
    resolver?.(Boolean(accepted));
  }, []);

  const dismissKiPrompt = useCallback(() => {
    setKiPrompt(null);
  }, []);

  const onError = useCallback(
    (err) => {
      const rawMessage = toErrorMessage(err);
      const message =
        typeof rawMessage === "string"
          ? rawMessage.trim()
          : String(rawMessage || "").trim();
      if (!message) {
        return;
      }
      setError(message);
      pushUiNotice(message);
    },
    [pushUiNotice],
  );

  // ---- Plugin controllers --------------------------------------------------
  // Each controller owns its state (paths, snapshots, transfers, timers) and
  // receives only the shared session context here. Order follows registration
  // (manifest) order; nothing SFTP/status-specific stays in this hook.
  //
  // The builtin controllers keep their original direct call and arguments,
  // with one addition: `api`, injected from `getPlugin(id).api` — the same
  // facade surface external plugins receive. A missing registration (an
  // unregistered builtin) degrades to `undefined`, which the controllers'
  // effects already treat as "no API" (polling/listeners stay off).
  //
  // `runWithSessionReconnect` is defined by the core session operations below
  // and assigned into `runWithSessionReconnectRef` synchronously in their
  // hook body, so the controllers can read it lazily through the ref without
  // depending on mount order. `resolveSessionAlias` has been the identity
  // map since sessions got stable ids.
  //
  // Both wrappers are useCallback-stable (they only read a ref), so the
  // controller context never changes identity just because a render happened.
  const lazyResolveSessionAlias = useCallback((sessionId) => sessionId || null, []);
  const lazyRunWithSessionReconnect = useCallback((sessionId, action) => {
    const run = runWithSessionReconnectRef.current;
    if (!run) {
      return Promise.reject(new Error("Session operations are not ready"));
    }
    return run(sessionId, action);
  }, []);

  const sftpController = useSftpController({
    sessions,
    activeSessionId,
    showSftpPanel,
    showStatusPanel,
    disconnectedSessions,
    sftpEnabled,
    api: getPlugin(SFTP_EXTENSION_ID)?.api,
    runBusy,
    onError,
    setError,
    pushUiNotice,
    resolveSessionAlias: lazyResolveSessionAlias,
    runWithSessionReconnect: lazyRunWithSessionReconnect,
  });
  const statusController = useStatusController({
    sessions,
    activeSessionId,
    showSftpPanel,
    showStatusPanel,
    disconnectedSessions,
    sftpEnabled,
    statusEnabled,
    api: getPlugin(STATUS_EXTENSION_ID)?.api,
    runBusy,
    onError,
    setError,
    pushUiNotice,
    resolveSessionAlias: lazyResolveSessionAlias,
    runWithSessionReconnect: lazyRunWithSessionReconnect,
  });

  // ---- External plugin controller hosts ------------------------------------
  // One keyed host per external plugin with a controller, rendered as
  // siblings by AppWorkspace. Builtins stay in the direct calls above; no
  // hook here ever loops over plugins.
  const pluginControllerHosts = usePluginControllerHosts();

  // ---- Plugin host context -------------------------------------------------
  // The shared workbench snapshot plugins read through
  // `ui.getContext()` / render props. Minimal ctx per the contract; published
  // every render so it never goes stale. The `api` never appears here —
  // panels receive their own plugin's facade in render props.
  setPluginHostContext({
    sessions,
    activeSessionId,
    activeSession,
    disconnectedSessions,
    showPanel,
    hidePanel,
    togglePanel,
  });

  // ---- Core session operations ---------------------------------------------
  const {
    appendLog,
    resolveSessionAlias,
    runWithSessionReconnect,
    bootstrap,
    saveSsh,
    connectServer,
    cancelConnectServer,
    closeSession,
    reopenSessionPty,
    markSessionDisconnected,
    sendCommandDraft,
    saveScript,
    runScript,
    sendPtyInput,
    resizePty,
    handleDeleteSsh,
    handleDeleteScript,
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
  } = useWorkbenchOperations({
    sshConfigs,
    sessions,
    activeSessionId,
    downloadDirectory: sftpController.downloadDirectory,
    setDownloadDirectory: sftpController.setDownloadDirectory,
    scriptForm,
    scripts,
    sshForm,
    setLogs,
    setDisconnectedSessions,
    setSftpPath: sftpController.setSftpPath,
    setStatusBySession: statusController.setStatusBySession,
    setNicBySession: statusController.setNicBySession,
    setSessions,
    setActiveSessionId,
    setOpenFileContent: sftpController.setOpenFileContent,
    setDirtyFile: sftpController.setDirtyFile,
    statusRequestTokenRef: statusController.statusRequestTokenRef,
    setScripts,
    setScriptForm,
    setSshConfigs,
    setSshForm,
    setError,
    reconnectingSessionsRef,
    closingSessionsRef,
    ptyInputSenderRef,
    onErrorRef,
    runWithSessionReconnectRef,
    pushUiNotice,
    dismissUiNotice,
    requestHostKeyTrust,
    runBusy,
    onError,
  });

  useWorkbenchEffects({
    theme,
    wallpaper,
    bootstrap,
    activeSessionId,
    markSessionDisconnected,
    currentPath: sftpController.currentPath,
    refreshSftp: sftpController.refreshSftp,
    resetFileEditor: sftpController.resetFileEditor,
    setKiPrompt,
  });

  // ---- Compat adapter ------------------------------------------------------
  // The original useWorkbench keys, mapped onto plugin-owned values so every
  // existing consumer (AppMainWorkspace, AppWorkspace, AppModals) works
  // unchanged. This is the only place plugin internals are flattened.
  return {
    theme,
    setTheme,
    wallpaper,
    setWallpaper,
    showSftpPanel,
    setShowSftpPanel,
    showStatusPanel,
    setShowStatusPanel,
    showCommandDraftPanel,
    setShowCommandDraftPanel,
    statusRefreshInterval: statusController.statusRefreshInterval,
    setStatusRefreshInterval: statusController.setStatusRefreshInterval,
    showAiPanel,
    setShowAiPanel,
    busy,
    error,
    uiNotices,
    dismissUiNotice,
    hostKeyTrustPrompt,
    resolveHostKeyTrust,
    kiPrompt,
    dismissKiPrompt,
    sshConfigs,
    sshForm,
    setSshForm,
    scripts,
    scriptForm,
    setScriptForm,
    sessions,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    commandDraft,
    setCommandDraft,

    // Extension state (plugins).
    extensions,
    setExtensionEnabled,
    sftpEnabled,
    statusEnabled,

    // SFTP plugin (paths, editor, transfers, download dir) under their
    // original workbench keys.
    downloadDirectory: sftpController.downloadDirectory,
    sftpTransfers: sftpController.sftpTransfers,
    currentPath: sftpController.currentPath,
    sftpEntries: sftpController.sftpEntries,
    selectedEntry: sftpController.selectedEntry,
    openFilePath: sftpController.openFilePath,
    dirtyFile: sftpController.dirtyFile,
    openFileContent: sftpController.openFileContent,

    // Core session operations, restored verbatim under their original keys.
    saveSsh,
    connectServer,
    cancelConnectServer,
    closeSession,
    reopenSessionPty,
    disconnectedSessions,
    sendCommandDraft,
    sendPtyInput,
    resizePty,
    saveScript,
    runScript,
    handleDeleteSsh,
    handleDeleteScript,

    // SFTP plugin operations under their original keys.
    requestSftpDir: sftpController.requestSftpDir,
    refreshSftp: sftpController.refreshSftp,
    openEntry: sftpController.openEntry,
    selectSftpEntry: sftpController.selectSftpEntry,
    uploadFile: sftpController.uploadFile,
    createSftpEntry: sftpController.createSftpEntry,
    downloadFile: sftpController.downloadFile,
    deleteSftpEntry: sftpController.deleteSftpEntry,
    renameSftpEntry: sftpController.renameSftpEntry,
    copySftpEntryPath: sftpController.copySftpEntryPath,
    cancelSftpTransfer: sftpController.cancelSftpTransfer,

    // Server-monitor plugin (snapshots, NIC selection, interval) under their
    // original workbench keys.
    currentStatus: statusController.currentStatus,
    currentNic: statusController.currentNic,
    handleNicChange: statusController.handleNicChange,

    // File editor + download directory handlers (the content change is a
    // plain setter pair; the directory change trims, both unchanged).
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
    formatBytes,

    // Generic plugin-consumer surface. `pluginControllerHosts` renders one
    // keyed host per external plugin (AppWorkspace mounts it as a sibling);
    // `panelVisibility` is the generic visibility map; show/hide/toggle are
    // the general helpers the plugin host context exposes.
    pluginControllerHosts,
    panelVisibility,
    showPanel,
    hidePanel,
    togglePanel,
  };
}
