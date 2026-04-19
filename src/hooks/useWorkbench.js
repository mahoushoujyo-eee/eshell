import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_AI,
  DEFAULT_WALLPAPER,
  EMPTY_SCRIPT,
  EMPTY_SSH,
  normalizeWallpaperSelection,
} from "../constants/workbench";
import { EMPTY_OPS_AGENT_STREAM } from "../lib/ops-agent-stream";
import { formatBytes } from "../utils/format";
import { normalizeRemotePath } from "../utils/path";
import { DEFAULT_AI_PROFILE_FORM } from "./workbench/aiProfiles";
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
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uiNotices, setUiNotices] = useState([]);

  const [sshConfigs, setSshConfigs] = useState([]);
  const [sshForm, setSshForm] = useState(EMPTY_SSH);

  const [scripts, setScripts] = useState([]);
  const [scriptForm, setScriptForm] = useState(EMPTY_SCRIPT);

  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [logs, setLogs] = useState({});
  const [ptyOutputBySession, setPtyOutputBySession] = useState({});
  const [commandInput, setCommandInput] = useState("");
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
  const [openFileContent, setOpenFileContent] = useState("");
  const [dirtyFile, setDirtyFile] = useState(false);

  const [statusBySession, setStatusBySession] = useState({});
  const [nicBySession, setNicBySession] = useState({});

  const [aiConfig, setAiConfig] = useState(DEFAULT_AI);
  const [aiProfiles, setAiProfiles] = useState([]);
  const [activeAiProfileId, setActiveAiProfileId] = useState(null);
  const [aiProfileForm, setAiProfileForm] = useState(DEFAULT_AI_PROFILE_FORM);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiShellContext, setAiShellContext] = useState(null);
  const [aiImageAttachments, setAiImageAttachments] = useState([]);
  const [aiConversations, setAiConversations] = useState([]);
  const [activeAiConversationId, setActiveAiConversationId] = useState(null);
  const [activeAiConversation, setActiveAiConversation] = useState(null);
  const [aiPendingActions, setAiPendingActions] = useState([]);
  const [aiStream, setAiStream] = useState(EMPTY_OPS_AGENT_STREAM);
  const [resolvingAiActionId, setResolvingAiActionId] = useState("");
  const [aiConversationErrors, setAiConversationErrors] = useState({});
  const [aiStandaloneError, setAiStandaloneError] = useState("");

  const saveTimerRef = useRef(null);
  const reconnectingSessionsRef = useRef(new Map());
  const sessionAliasRef = useRef(new Map());
  const statusRequestTokenRef = useRef(new Map());
  const aiStreamRef = useRef(EMPTY_OPS_AGENT_STREAM);
  const aiImageAttachmentsRef = useRef([]);
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

  const setAiConversationError = useCallback((conversationId, err) => {
    const rawMessage = toErrorMessage(err);
    const message =
      typeof rawMessage === "string"
        ? rawMessage.trim()
        : String(rawMessage || "").trim();
    if (!message) {
      return;
    }

    if (conversationId) {
      setAiConversationErrors((prev) => ({
        ...prev,
        [conversationId]: message,
      }));
      return;
    }

    setAiStandaloneError(message);
  }, []);

  const clearAiConversationError = useCallback((conversationId = null) => {
    if (conversationId) {
      setAiConversationErrors((prev) => {
        if (!(conversationId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
      return;
    }
    setAiStandaloneError("");
  }, []);

  const clearActiveAiConversationError = useCallback(() => {
    if (activeAiConversationId) {
      clearAiConversationError(activeAiConversationId);
      return;
    }
    clearAiConversationError(null);
  }, [activeAiConversationId, clearAiConversationError]);

  const runBusy = useCallback(async (text, action) => {
    setBusy(text);
    setError("");
    try {
      return await action();
    } finally {
      setBusy("");
    }
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

  useEffect(() => {
    aiImageAttachmentsRef.current = aiImageAttachments;
  }, [aiImageAttachments]);

  const {
    appendLog,
    appendPtyOutput,
    resolveSessionAlias,
    runWithSessionReconnect,
    applyAiProfilesState,
    reloadAiConversations,
    loadAiConversation,
    reloadAiPendingActions,
    bootstrap,
    saveSsh,
    connectServer,
    closeSession,
    execCommand,
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    uploadFile,
    downloadFile,
    deleteSftpEntry,
    cancelSftpTransfer,
    refreshStatus,
    saveScript,
    runScript,
    sendPtyInput,
    resizePty,
    saveAiProfile,
    selectAiProfile,
    deleteAiProfile,
    saveAiApprovalMode,
    selectAiConversation,
    createAiConversation,
    deleteAiConversation,
    compactAiConversation,
    resolveAiPendingAction,
    askAi,
    cancelAiStreaming,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
    attachAiShellContext,
    attachAiImages,
    removeAiImageAttachment,
    clearAiImageAttachments,
    clearAiShellContext,
  } = useWorkbenchOperations({
    sshConfigs,
    sessions,
    activeSessionId,
    commandInput,
    currentPath,
    downloadDirectory,
    selectedEntry,
    scriptForm,
    scripts,
    sshForm,
    aiProfileForm,
    aiQuestion,
    aiShellContext,
    aiImageAttachments,
    aiStream,
    activeAiConversationId,
    setLogs,
    setPtyOutputBySession,
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
    setOpenFileContent,
    setDirtyFile,
    setScripts,
    setScriptForm,
    setSshConfigs,
    setSshForm,
    setAiConfig,
    setAiProfiles,
    setActiveAiProfileId,
    setAiProfileForm,
    setAiConversations,
    setAiPendingActions,
    setActiveAiConversationId,
    setActiveAiConversation,
    setResolvingAiActionId,
    setAiQuestion,
    setAiShellContext,
    setAiImageAttachments,
    setAiStream,
    setAiConversationError,
    clearAiConversationError,
    setDownloadDirectory,
    setError,
    reconnectingSessionsRef,
    sessionAliasRef,
    statusRequestTokenRef,
    aiStreamRef,
    ptyInputSenderRef,
    onErrorRef,
    runWithSessionReconnectRef,
    pushUiNotice,
    dismissUiNotice,
    runBusy,
    onError,
  });

  useEffect(
    () => () => {
      aiImageAttachmentsRef.current.forEach((attachment) => {
        if (
          typeof attachment?.previewUrl === "string" &&
          attachment.previewUrl.startsWith("blob:")
        ) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    },
    [],
  );

  useWorkbenchEffects({
    theme,
    wallpaper,
    downloadDirectory,
    bootstrap,
    aiStream,
    aiStreamRef,
    appendPtyOutput,
    activeSessionId,
    loadAiConversation,
    onError,
    setAiConversationError,
    clearAiConversationError,
    reloadAiConversations,
    reloadAiPendingActions,
    setAiStream,
    setActiveAiConversationId,
    setAiPendingActions,
    setSftpTransfers,
    activeAiConversationId,
    setActiveAiConversation,
    setSftpEntries,
    setOpenFilePath,
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
  });

  const currentPtyOutput = activeSessionId ? ptyOutputBySession[activeSessionId] || "" : "";
  const aiStreamingText =
    aiStream.conversationId === activeAiConversationId ? aiStream.text : "";
  const aiStreamingToolCalls =
    aiStream.conversationId === activeAiConversationId ? aiStream.toolCalls || [] : [];
  const isAiStreaming =
    Boolean(aiStream.runId) && aiStream.conversationId === activeAiConversationId;
  const activeAiConversationError = activeAiConversationId
    ? aiConversationErrors[activeAiConversationId] || ""
    : aiStandaloneError;

  return {
    theme,
    setTheme,
    wallpaper,
    setWallpaper,
    showSftpPanel,
    setShowSftpPanel,
    showStatusPanel,
    setShowStatusPanel,
    showAiPanel,
    setShowAiPanel,
    busy,
    error,
    uiNotices,
    dismissUiNotice,
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
    commandInput,
    setCommandInput,
    downloadDirectory,
    sftpTransfers,
    currentPtyOutput,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    openFilePath,
    dirtyFile,
    openFileContent,
    aiConfig,
    aiProfiles,
    activeAiProfileId,
    aiProfileForm,
    setAiProfileForm,
    aiQuestion,
    setAiQuestion,
    aiShellContext,
    aiImageAttachments,
    aiConversations,
    activeAiConversationId,
    activeAiConversation,
    aiPendingActions,
    isAiStreaming,
    aiStreamingText,
    aiStreamingToolCalls,
    activeAiConversationError,
    clearActiveAiConversationError,
    resolvingAiActionId,
    saveSsh,
    connectServer,
    closeSession,
    execCommand,
    sendPtyInput,
    resizePty,
    uploadFile,
    downloadFile,
    deleteSftpEntry,
    cancelSftpTransfer,
    saveScript,
    runScript,
    saveAiProfile,
    selectAiProfile,
    deleteAiProfile,
    saveAiApprovalMode,
    selectAiConversation,
    createAiConversation,
    deleteAiConversation,
    compactAiConversation,
    resolveAiPendingAction,
    askAi,
    cancelAiStreaming,
    attachAiShellContext,
    attachAiImages,
    removeAiImageAttachment,
    clearAiImageAttachments,
    clearAiShellContext,
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    deleteSftpEntry,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    handleDownloadDirectoryChange,
    formatBytes,
  };
}
