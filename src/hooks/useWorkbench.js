import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_WALLPAPER,
  EMPTY_SCRIPT,
  EMPTY_SSH,
  normalizeWallpaperSelection,
} from "../constants/workbench";
import { formatBytes } from "../utils/format";
import { normalizeRemotePath } from "../utils/path";
import { toErrorMessage } from "./workbench/errors";
import { useWorkbenchEffects } from "./workbench/effects";
import { useWorkbenchOperations } from "./workbench/operations";

export function useWorkbench() {
  const MAX_UI_NOTICES = 4;
  const DEFAULT_NOTICE_TTL_MS = 5200;

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
  const [showSftpPanel, setShowSftpPanel] = useState(false);
  const [showStatusPanel, setShowStatusPanel] = useState(false);
  const [showCommandDraftPanel, setShowCommandDraftPanel] = useState(false);
  const [statusRefreshInterval, setStatusRefreshInterval] = useState(() => {
    if (typeof window === "undefined") return 5000;
    return parseInt(window.localStorage.getItem("eshell:status-refresh-interval") || "5000", 10) || 5000;
  });
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
  const [downloadDirectory, setDownloadDirectory] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem("eshell:sftp-download-dir") || "";
  });
  const [sftpTransfers, setSftpTransfers] = useState([]);

  const [sftpPath, setSftpPath] = useState({});
  const [sftpEntries, setSftpEntries] = useState([]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [openFilePath, setOpenFilePath] = useState("");
  // Which session the open file was read from. Saves must go back to that
  // session rather than whichever tab happens to be active when the debounced
  // write fires, otherwise switching tabs mid-edit writes to the wrong server.
  const [openFileSessionId, setOpenFileSessionId] = useState(null);
  const [openFileContent, setOpenFileContent] = useState("");
  const [dirtyFile, setDirtyFile] = useState(false);

  const [statusBySession, setStatusBySession] = useState({});
  const [nicBySession, setNicBySession] = useState({});

  const saveTimerRef = useRef(null);
  const reconnectingSessionsRef = useRef(new Map());
  const closingSessionsRef = useRef(new Set());
  const kiPromptDismissRef = useRef(null);
  const sessionAliasRef = useRef(new Map());
  const statusRequestTokenRef = useRef(new Map());
  const ptyInputSenderRef = useRef(null);
  const onErrorRef = useRef(() => {});
  const runWithSessionReconnectRef = useRef(null);

  const activeSession = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );
  const currentPath = useMemo(
    () =>
      normalizeRemotePath(
        activeSession ? sftpPath[activeSession.id] || activeSession.currentDir || "/" : "/",
      ),
    [activeSession, sftpPath],
  );
  const currentStatus = activeSessionId ? statusBySession[activeSessionId] : null;
  const currentNic = activeSessionId ? nicBySession[activeSessionId] || null : null;

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
    kiPromptDismissRef.current = null;
  }, []);

  const onError = useCallback((err) => {
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
  }, [pushUiNotice]);

  const {
    appendLog,
    resolveSessionAlias,
    runWithSessionReconnect,
    bootstrap,
    saveSsh,
    connectServer,
    cancelConnectServer,
    closeSession,
    reconnectSession,
    markSessionDisconnected,
    sendCommandDraft,
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    uploadFile,
    createSftpEntry,
    downloadFile,
    deleteSftpEntry,
    renameSftpEntry,
    copySftpEntryPath,
    cancelSftpTransfer,
    refreshStatus,
    saveScript,
    runScript,
    sendPtyInput,
    resizePty,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
  } = useWorkbenchOperations({
    sshConfigs,
    sessions,
    activeSessionId,
    currentPath,
    downloadDirectory,
    selectedEntry,
    scriptForm,
    scripts,
    sshForm,
    setLogs,
    setDisconnectedSessions,
    setSftpPath,
    setStatusBySession,
    setNicBySession,
    setSessions,
    setActiveSessionId,
    setSftpEntries,
    setSftpTransfers,
    setSelectedEntry,
    openFilePath,
    setOpenFilePath,
    openFileSessionId,
    setOpenFileSessionId,
    setOpenFileContent,
    setDirtyFile,
    setScripts,
    setScriptForm,
    setSshConfigs,
    setSshForm,
    setDownloadDirectory,
    setError,
    reconnectingSessionsRef,
    closingSessionsRef,
    sessionAliasRef,
    statusRequestTokenRef,
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
    downloadDirectory,
    bootstrap,
    activeSessionId,
    disconnectedSessions,
    markSessionDisconnected,
    onError,
    setSftpTransfers,
    setSftpEntries,
    setSelectedEntry,
    setOpenFilePath,
    openFileSessionId,
    setOpenFileSessionId,
    setOpenFileContent,
    setDirtyFile,
    currentPath,
    refreshSftp,
    showSftpPanel,
    showStatusPanel,
    refreshStatus,
    currentNic,
    saveTimerRef,
    openFilePath,
    dirtyFile,
    runBusy,
    runWithSessionReconnect,
    openFileContent,
    setKiPrompt,
    statusRefreshInterval,
  });

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
    statusRefreshInterval,
    setStatusRefreshInterval,
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
    downloadDirectory,
    sftpTransfers,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    openFilePath,
    dirtyFile,
    openFileContent,
    saveSsh,
    connectServer,
    cancelConnectServer,
    closeSession,
    reconnectSession,
    disconnectedSessions,
    sendCommandDraft,
    sendPtyInput,
    resizePty,
    uploadFile,
    createSftpEntry,
    downloadFile,
    deleteSftpEntry,
    renameSftpEntry,
    copySftpEntryPath,
    cancelSftpTransfer,
    saveScript,
    runScript,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    formatBytes,
  };
}
