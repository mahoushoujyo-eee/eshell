import { useCallback, useEffect, useRef } from "react";
import { DEFAULT_AI, EMPTY_SCRIPT, EMPTY_SSH } from "../../constants/workbench";
import { useI18n } from "../../lib/i18n";
import { EMPTY_OPS_AGENT_STREAM } from "../../lib/ops-agent-stream";
import { createShellContextAttachment } from "../../lib/ops-agent-shell-context";
import { createPtyInputSender } from "../../lib/pty-input-sender";
import { createSftpTransferSeed, upsertSftpTransfer } from "../../lib/sftp-transfer";
import { api } from "../../lib/tauri-api";
import { arrayBufferToBase64 } from "../../utils/encoding";
import { joinPath, normalizeRemotePath } from "../../utils/path";
import {
  DEFAULT_AI_PROFILE_FORM,
  normalizeAiConfig,
  normalizeAiProfilesState,
  toAiProfileInput,
} from "./aiProfiles";
import {
  STATUS_FETCH_WARNING_PREFIX,
  isSessionLostError,
  toErrorMessage,
} from "./errors";
import { shellQuote, trimTerminalOutput } from "./session";

const isTransferCancelledError = (err) =>
  toErrorMessage(err).toLowerCase().includes("transfer cancelled by user");

export function useWorkbenchOperations({
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
}) {
  const { localeTag, t } = useI18n();
  const localeTagRef = useRef(localeTag);
  const tRef = useRef(t);

  useEffect(() => {
    localeTagRef.current = localeTag;
    tRef.current = t;
  }, [localeTag, t]);

  const appendLog = useCallback((sessionId, tag, text) => {
    if (!sessionId || !text) {
      return;
    }
    setLogs((prev) => {
      const rows = prev[sessionId] || [];
      return {
        ...prev,
        [sessionId]: [
          ...rows,
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            ts: new Date().toLocaleTimeString(localeTagRef.current),
            tag,
            text,
          },
        ],
      };
    });
  }, []);

  const appendPtyOutput = useCallback((sessionId, chunk) => {
    if (!sessionId || !chunk) {
      return;
    }
    setPtyOutputBySession((prev) => ({
      ...prev,
      [sessionId]: trimTerminalOutput(`${prev[sessionId] || ""}${chunk}`),
    }));
  }, []);

  const resolveSessionAlias = useCallback((sessionId) => {
    if (!sessionId) {
      return null;
    }
    return sessionAliasRef.current.get(sessionId) || sessionId;
  }, []);

  const clearSessionArtifacts = useCallback((sessionId) => {
    if (!sessionId) {
      return;
    }

    const aliasKeys = [];
    const relatedSessionIds = new Set([sessionId]);
    sessionAliasRef.current.forEach((value, key) => {
      if (key === sessionId || value === sessionId) {
        aliasKeys.push(key);
        if (typeof key === "string" && key) {
          relatedSessionIds.add(key);
        }
        if (typeof value === "string" && value) {
          relatedSessionIds.add(value);
        }
      }
    });

    const inputSender = ptyInputSenderRef.current;
    if (inputSender) {
      relatedSessionIds.forEach((id) => {
        inputSender.clearSession(id);
      });
    }

    aliasKeys.forEach((key) => {
      sessionAliasRef.current.delete(key);
    });

    reconnectingSessionsRef.current.delete(sessionId);
    statusRequestTokenRef.current.delete(sessionId);

    setPtyOutputBySession((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setSftpPath((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setStatusBySession((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setNicBySession((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setLogs((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const reconnectSession = useCallback(
    async (sessionId) => {
      const originSessionId = resolveSessionAlias(sessionId);
      if (!originSessionId) {
        throw new Error(tRef.current("No shell session selected"));
      }

      const existing = reconnectingSessionsRef.current.get(originSessionId);
      if (existing) {
        return existing;
      }

      const task = (async () => {
        const staleSession = sessions.find((item) => item.id === originSessionId);
        if (!staleSession?.configId) {
          throw new Error(
            tRef.current("Shell session lost and cannot auto-reconnect: {sessionId}", {
              sessionId: originSessionId,
            }),
          );
        }

        const reopened = await api.openShellSession(staleSession.configId);
        sessionAliasRef.current.set(originSessionId, reopened.id);

        const restoreDir = normalizeRemotePath(staleSession.currentDir || reopened.currentDir || "/");
        if (restoreDir && restoreDir !== "/") {
          try {
            await api.ptyWriteInput(reopened.id, `cd ${shellQuote(restoreDir)}\n`);
          } catch (_err) {
            // Ignore restore-dir failures and keep the recovered session usable.
          }
        }

        setSessions((prev) => {
          const next = prev.filter((item) => item.id !== originSessionId && item.id !== reopened.id);
          return [...next, reopened];
        });
        setActiveSessionId((prev) => (prev === originSessionId ? reopened.id : prev));

        setSftpPath((prev) => {
          const rememberedPath =
            prev[originSessionId] || staleSession.currentDir || reopened.currentDir || "/";
          const next = {
            ...prev,
            [reopened.id]: normalizeRemotePath(rememberedPath),
          };
          delete next[originSessionId];
          return next;
        });
        setPtyOutputBySession((prev) => {
          const rememberedOutput = prev[originSessionId] || "";
          const next = { ...prev, [reopened.id]: rememberedOutput };
          delete next[originSessionId];
          return next;
        });
        setStatusBySession((prev) => {
          if (!(originSessionId in prev)) {
            return prev;
          }
          const next = { ...prev, [reopened.id]: prev[originSessionId] };
          delete next[originSessionId];
          return next;
        });
        setNicBySession((prev) => {
          if (!(originSessionId in prev)) {
            return prev;
          }
          const next = { ...prev, [reopened.id]: prev[originSessionId] };
          delete next[originSessionId];
          return next;
        });
        setLogs((prev) => {
          if (!(originSessionId in prev)) {
            return prev;
          }
          const next = { ...prev, [reopened.id]: prev[originSessionId] };
          delete next[originSessionId];
          return next;
        });

        appendLog(reopened.id, "SYSTEM", tRef.current("Session disconnected. Auto-reconnected."));
        return reopened;
      })();

      reconnectingSessionsRef.current.set(originSessionId, task);
      try {
        return await task;
      } finally {
        reconnectingSessionsRef.current.delete(originSessionId);
      }
    },
    [appendLog, resolveSessionAlias, sessions],
  );

  const runWithSessionReconnect = useCallback(
    async (sessionId, action) => {
      const resolvedSessionId = resolveSessionAlias(sessionId);
      if (!resolvedSessionId) {
        throw new Error(tRef.current("No shell session selected"));
      }

      try {
        return await action(resolvedSessionId);
      } catch (err) {
        if (!isSessionLostError(err)) {
          throw err;
        }
        const reopened = await reconnectSession(resolvedSessionId);
        return action(reopened.id);
      }
    },
    [reconnectSession, resolveSessionAlias],
  );

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    runWithSessionReconnectRef.current = runWithSessionReconnect;
  }, [runWithSessionReconnect]);

  useEffect(() => {
    const sender = createPtyInputSender({
      send: (sessionId, data) => {
        const runWithReconnect = runWithSessionReconnectRef.current;
        if (typeof runWithReconnect !== "function") {
          return Promise.reject(new Error(tRef.current("PTY input sender is not ready")));
        }
        return runWithReconnect(sessionId, (activeId) => api.ptyWriteInput(activeId, data));
      },
      onError: (error) => {
        onErrorRef.current(error);
      },
    });
    ptyInputSenderRef.current = sender;

    return () => {
      sender.dispose();
      if (ptyInputSenderRef.current === sender) {
        ptyInputSenderRef.current = null;
      }
    };
  }, []);

  const applyAiProfilesState = useCallback((state, keepForm = false) => {
    const normalized = normalizeAiProfilesState(state);
    setAiProfiles(normalized.profiles);
    setActiveAiProfileId(normalized.activeProfileId);

    const activeProfile =
      normalized.profiles.find((item) => item.id === normalized.activeProfileId) || null;
    if (activeProfile) {
      setAiConfig(normalizeAiConfig({ ...activeProfile, approvalMode: normalized.approvalMode }));
      if (!keepForm) {
        setAiProfileForm(activeProfile);
      }
      return activeProfile;
    }

    setAiConfig(normalizeAiConfig({ ...DEFAULT_AI, approvalMode: normalized.approvalMode }));
    if (!keepForm) {
      setAiProfileForm(DEFAULT_AI_PROFILE_FORM);
    }
    return null;
  }, []);

  const reloadAiConversations = useCallback(async () => {
    const rows = await api.opsAgentListConversations();
    setAiConversations(rows);
    return rows;
  }, []);

  const loadAiConversation = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        setActiveAiConversation(null);
        return null;
      }
      const conversation = await api.opsAgentGetConversation(conversationId);
      setActiveAiConversation(conversation);
      return conversation;
    },
    [],
  );

  const reloadAiPendingActions = useCallback(
    async (sessionId) => {
      const rows = await api.opsAgentListPendingActions(sessionId || null, true);
      setAiPendingActions(rows);
      return rows;
    },
    [],
  );

  const bootstrap = useCallback(async () => {
    try {
      await runBusy(tRef.current("Loading project"), async () => {
        const loadDefaultDirTask = downloadDirectory?.trim()
          ? Promise.resolve(downloadDirectory)
          : api.sftpDefaultDownloadDir().catch(() => "");

        const [
          configs,
          scriptRows,
          aiProfilesState,
          opened,
          conversations,
          pendingActions,
          defaultDownloadDir,
        ] = await Promise.all([
          api.listSshConfigs(),
          api.listScripts(),
          api.listAiProfiles(),
          api.listShellSessions(),
          api.opsAgentListConversations(),
          api.opsAgentListPendingActions(null, true),
          loadDefaultDirTask,
        ]);
        setSshConfigs(configs);
        setScripts(scriptRows);
        applyAiProfilesState(aiProfilesState);
        setAiConversations(conversations);
        setAiPendingActions(pendingActions);
        if (!downloadDirectory?.trim() && defaultDownloadDir) {
          setDownloadDirectory(defaultDownloadDir);
        }

        setSessions(opened);
        if (opened[0]) {
          setActiveSessionId(opened[0].id);
        }
        const initialConversationId = conversations[0]?.id || null;
        setActiveAiConversationId(initialConversationId);
        if (initialConversationId) {
          const conversation = await api.opsAgentGetConversation(initialConversationId);
          setActiveAiConversation(conversation);
        } else {
          setActiveAiConversation(null);
        }
      });
    } catch (err) {
      onError(err);
    }
  }, [applyAiProfilesState, downloadDirectory, onError, runBusy, setDownloadDirectory]);

  const reloadSessions = useCallback(async () => {
    const rows = await api.listShellSessions();
    setSessions(rows);
    return rows;
  }, []);

  const saveSsh = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy(tRef.current("Save SSH config"), () =>
          api.saveSshConfig({
            id: sshForm.id || null,
            name: sshForm.name,
            host: sshForm.host,
            port: Number(sshForm.port || 22),
            username: sshForm.username,
            password: sshForm.password,
            description: sshForm.description,
          }),
        );
        setSshForm(EMPTY_SSH);
        setSshConfigs(await api.listSshConfigs());
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [onError, runBusy, sshForm],
  );

  const connectServer = useCallback(
    async (configId) => {
      const targetConfig = sshConfigs.find((item) => item.id === configId) || null;
      const targetLabel =
        targetConfig?.name || targetConfig?.host || tRef.current("SSH Servers");
      const pendingNoticeId = pushUiNotice(
        tRef.current("Connecting to {target}...", { target: targetLabel }),
        {
        tone: "info",
        ttlMs: 0,
        },
      );

      try {
        const session = await runBusy(tRef.current("Open SSH session"), () =>
          api.openShellSession(configId),
        );
        dismissUiNotice(pendingNoticeId);
        await reloadSessions();
        setActiveSessionId(session.id);
        setSftpPath((prev) => ({
          ...prev,
          [session.id]: normalizeRemotePath(session.currentDir || "/"),
        }));
        setPtyOutputBySession((prev) => ({ ...prev, [session.id]: "" }));
        appendLog(
          session.id,
          "SYSTEM",
          tRef.current("Connected to {name} ({dir})", {
            name: session.configName,
            dir: session.currentDir,
          }),
        );
        pushUiNotice(
          tRef.current("Connected to {name} ({dir})", {
            name: session.configName,
            dir: session.currentDir,
          }),
          {
          tone: "success",
          ttlMs: 4200,
          },
        );
        return true;
      } catch (err) {
        dismissUiNotice(pendingNoticeId);
        const reason = toErrorMessage(err);
        const message = tRef.current("Failed to connect to {target}: {reason}", {
          target: targetLabel,
          reason,
        });
        setError(message);
        pushUiNotice(message, { tone: "danger" });
        return false;
      }
    },
    [
      appendLog,
      dismissUiNotice,
      pushUiNotice,
      reloadSessions,
      runBusy,
      setError,
      sshConfigs,
    ],
  );

  const closeSession = useCallback(
    async (sessionId) => {
      if (!sessionId) {
        return;
      }
      const resolvedSessionId = resolveSessionAlias(sessionId);
      let rows = null;
      try {
        await runBusy(tRef.current("Close session"), () => api.closeShellSession(resolvedSessionId));
        rows = await reloadSessions();
      } catch (err) {
        if (!isSessionLostError(err)) {
          onError(err);
          return;
        }
        rows = await reloadSessions().catch(() => null);
      }

      clearSessionArtifacts(resolvedSessionId);
      if (resolvedSessionId !== sessionId) {
        clearSessionArtifacts(sessionId);
      }

      if (rows) {
        if (activeSessionId === sessionId || activeSessionId === resolvedSessionId) {
          setActiveSessionId(rows[0]?.id || null);
        }
      } else {
        setSessions((prev) =>
          prev.filter((item) => item.id !== sessionId && item.id !== resolvedSessionId),
        );
        if (activeSessionId === sessionId || activeSessionId === resolvedSessionId) {
          setActiveSessionId(null);
        }
      }
    },
    [activeSessionId, clearSessionArtifacts, onError, reloadSessions, resolveSessionAlias, runBusy],
  );

  const execCommand = useCallback(
    async (event) => {
      event.preventDefault();
      if (!activeSessionId || !commandInput.trim()) {
        return;
      }
      const command = commandInput;
      setCommandInput("");
      try {
        await runWithSessionReconnect(activeSessionId, (sessionId) =>
          api.ptyWriteInput(sessionId, `${command}\n`),
        );
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, commandInput, onError, runWithSessionReconnect],
  );

  const requestSftpDir = useCallback(
    async (path) => {
      if (!activeSessionId) {
        return null;
      }
      try {
        const normalizedPath = normalizeRemotePath(path);
        return await runBusy(tRef.current("Read directory"), () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.sftpListDir(sessionId, normalizedPath),
          ),
        );
      } catch (err) {
        onError(err);
        return null;
      }
    },
    [activeSessionId, onError, runBusy, runWithSessionReconnect],
  );

  const refreshSftp = useCallback(
    async (path) => {
      if (!activeSessionId) {
        return null;
      }
      const requestedSessionId = activeSessionId;
      const result = await requestSftpDir(path);
      if (!result) {
        return null;
      }
      const targetSessionId = resolveSessionAlias(requestedSessionId) || requestedSessionId;
      setSftpEntries(result.entries);
      setSftpPath((prev) => ({
        ...prev,
        [targetSessionId]: normalizeRemotePath(result.path),
      }));
      setSelectedEntry(null);
      return result;
    },
    [activeSessionId, requestSftpDir, resolveSessionAlias],
  );

  const openEntry = useCallback(
    async (entry) => {
      if (!activeSessionId) {
        return { opened: false };
      }
      setSelectedEntry(entry);
      if (entry.entryType === "directory") {
        await refreshSftp(entry.path);
        return { opened: false };
      }
      try {
        const file = await runBusy(tRef.current("Read file"), () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.sftpReadFile(sessionId, entry.path),
          ),
        );
        setOpenFilePath(normalizeRemotePath(file.path));
        setOpenFileContent(file.content || "");
        setDirtyFile(false);
        return { opened: true, path: normalizeRemotePath(file.path) };
      } catch (err) {
        onError(err);
        return { opened: false };
      }
    },
    [activeSessionId, onError, refreshSftp, runBusy, runWithSessionReconnect],
  );

  const selectSftpEntry = useCallback((entry) => {
    setSelectedEntry(entry || null);
  }, [setSelectedEntry]);

  const uploadFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file || !activeSessionId) {
        return;
      }
      const transferId = globalThis.crypto?.randomUUID?.() || `upload-${Date.now()}-${Math.random()}`;
      const remotePath = joinPath(currentPath, file.name);
      const seed = createSftpTransferSeed({
        transferId,
        sessionId: activeSessionId,
        direction: "upload",
        remotePath,
        localPath: file.name,
        fileName: file.name,
        totalBytes: file.size,
      });
      if (seed) {
        setSftpTransfers((prev) => upsertSftpTransfer(prev, seed));
      }

      try {
        const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
        await runBusy(tRef.current("Upload file"), () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.sftpUploadFileWithProgress(
              sessionId,
              remotePath,
              contentBase64,
              transferId,
              file.name,
            ),
          ),
        );
        await refreshSftp(currentPath);
      } catch (err) {
        const cancelled = isTransferCancelledError(err);
        setSftpTransfers((prev) =>
          upsertSftpTransfer(prev, {
            transferId,
            sessionId: activeSessionId,
            direction: "upload",
            stage: cancelled ? "cancelled" : "failed",
            remotePath,
            localPath: file.name,
            fileName: file.name,
            transferredBytes: 0,
            totalBytes: file.size,
            percent: 0,
            message: cancelled ? tRef.current("Transfer cancelled") : toErrorMessage(err),
          }),
        );
        if (!cancelled) {
          onError(err);
        }
      } finally {
        event.target.value = "";
      }
    },
    [
      activeSessionId,
      currentPath,
      onError,
      refreshSftp,
      runBusy,
      runWithSessionReconnect,
      setSftpTransfers,
    ],
  );

  const downloadFile = useCallback(async (entry = null) => {
    const targetEntry = entry || selectedEntry;
    if (!activeSessionId || !targetEntry || targetEntry.entryType === "directory") {
      return;
    }
    const localDir = (downloadDirectory || "").trim();
    if (!localDir) {
      onError(tRef.current("Please set a local download directory first"));
      return;
    }

    const transferId =
      globalThis.crypto?.randomUUID?.() || `download-${Date.now()}-${Math.random()}`;
    const remotePath = normalizeRemotePath(targetEntry.path);
    const seed = createSftpTransferSeed({
      transferId,
      sessionId: activeSessionId,
      direction: "download",
      remotePath,
      localPath: localDir,
      fileName: targetEntry.name || "download.bin",
      totalBytes: targetEntry.size || null,
    });
    if (seed) {
      setSftpTransfers((prev) => upsertSftpTransfer(prev, seed));
    }

    try {
      const result = await runBusy(tRef.current("Download file"), () =>
        runWithSessionReconnect(activeSessionId, (sessionId) =>
          api.sftpDownloadFileToLocal(sessionId, remotePath, localDir, transferId),
        ),
      );
      setSftpTransfers((prev) =>
        upsertSftpTransfer(prev, {
          transferId,
          sessionId: activeSessionId,
          direction: "download",
          stage: "completed",
          remotePath: result.remotePath || remotePath,
          localPath: result.localPath || localDir,
          fileName: result.fileName || targetEntry.name || "download.bin",
          transferredBytes: result.size || targetEntry.size || 0,
          totalBytes: result.size || targetEntry.size || null,
          percent: 100,
          message: "",
        }),
      );
    } catch (err) {
      const cancelled = isTransferCancelledError(err);
      setSftpTransfers((prev) =>
        upsertSftpTransfer(prev, {
          transferId,
          sessionId: activeSessionId,
          direction: "download",
          stage: cancelled ? "cancelled" : "failed",
          remotePath,
          localPath: localDir,
          fileName: targetEntry.name || "download.bin",
          transferredBytes: 0,
          totalBytes: targetEntry.size || null,
          percent: 0,
          message: cancelled ? tRef.current("Transfer cancelled") : toErrorMessage(err),
        }),
      );
      if (!cancelled) {
        onError(err);
      }
    }
  }, [
    activeSessionId,
    downloadDirectory,
    onError,
    runBusy,
    runWithSessionReconnect,
    selectedEntry,
    setSftpTransfers,
  ]);

  const deleteSftpEntry = useCallback(
    async (entry = null) => {
      const targetEntry = entry || selectedEntry;
      if (!activeSessionId || !targetEntry) {
        return false;
      }

      const remotePath = normalizeRemotePath(targetEntry.path);
      try {
        await runBusy(tRef.current("Delete remote file"), () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.sftpDeleteEntry(sessionId, remotePath, targetEntry.entryType),
          ),
        );

        if (
          targetEntry.entryType !== "directory" &&
          openFilePath &&
          normalizeRemotePath(openFilePath) === remotePath
        ) {
          setOpenFilePath("");
          setOpenFileContent("");
          setDirtyFile(false);
        }

        await refreshSftp(currentPath);
        setSelectedEntry(null);
        pushUiNotice(tRef.current("Deleted {name}", { name: targetEntry.name || remotePath }), {
          tone: "success",
          ttlMs: 4200,
        });
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [
      activeSessionId,
      currentPath,
      onError,
      openFilePath,
      pushUiNotice,
      refreshSftp,
      runBusy,
      runWithSessionReconnect,
      selectedEntry,
      setDirtyFile,
      setOpenFileContent,
      setOpenFilePath,
      setSelectedEntry,
    ],
  );

  const cancelSftpTransfer = useCallback(
    async (transferId) => {
      if (!transferId) {
        return;
      }
      try {
        await api.sftpCancelTransfer(transferId);
        setSftpTransfers((prev) =>
          upsertSftpTransfer(prev, {
            transferId,
            stage: "cancelled",
            message: tRef.current("Cancellation requested"),
          }),
        );
      } catch (err) {
        onError(err);
      }
    },
    [onError, setSftpTransfers],
  );

  const refreshStatus = useCallback(
    async (sessionId, nic) => {
      if (!sessionId) {
        return;
      }
      const resolvedSessionId = resolveSessionAlias(sessionId) || sessionId;
      const requestedNic = typeof nic === "string" && nic.trim() ? nic : null;
      const requestToken = Symbol(resolvedSessionId);
      const statusWarningMessage = tRef.current(STATUS_FETCH_WARNING_PREFIX);
      statusRequestTokenRef.current.set(resolvedSessionId, requestToken);

      try {
        const statusResult = await runWithSessionReconnect(resolvedSessionId, async (activeId) => {
          const cached = await api.getCachedServerStatus(activeId);
          const live = await api.fetchServerStatus(activeId, requestedNic);
          return {
            activeId,
            cached,
            live,
          };
        });

        const tokenKey = statusResult.activeId || resolvedSessionId;
        const latestToken =
          statusRequestTokenRef.current.get(tokenKey) ??
          statusRequestTokenRef.current.get(resolvedSessionId);
        if (latestToken !== requestToken) {
          return;
        }
        if (statusResult.activeId !== resolvedSessionId) {
          statusRequestTokenRef.current.set(statusResult.activeId, requestToken);
        }

        if (statusResult.cached) {
          setStatusBySession((prev) => ({ ...prev, [statusResult.activeId]: statusResult.cached }));
        }
        setStatusBySession((prev) => ({ ...prev, [statusResult.activeId]: statusResult.live }));

        // Respect explicit user selection and only auto-pick NIC when no preference is provided.
        if (!requestedNic && statusResult.live.selectedInterface) {
          setNicBySession((prev) => ({
            ...prev,
            [statusResult.activeId]: statusResult.live.selectedInterface,
          }));
        }

        setError((prev) => {
          const current = typeof prev === "string" ? prev.trim() : "";
          return current === STATUS_FETCH_WARNING_PREFIX || current === statusWarningMessage ? "" : prev;
        });
      } catch (err) {
        setError((prev) => {
          const current = typeof prev === "string" ? prev.trim() : "";
          if (
            current &&
            current !== STATUS_FETCH_WARNING_PREFIX &&
            current !== statusWarningMessage
          ) {
            return prev;
          }
          return statusWarningMessage;
        });
      }
    },
    [resolveSessionAlias, runWithSessionReconnect],
  );

  const saveScript = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy(tRef.current("Save script"), () => api.saveScript(scriptForm));
        setScriptForm(EMPTY_SCRIPT);
        setScripts(await api.listScripts());
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy, scriptForm],
  );

  const runScript = useCallback(
    async (scriptId) => {
      if (!activeSessionId) {
        onError(tRef.current("Please connect an SSH session first"));
        return;
      }

      const script = scripts.find((item) => item.id === scriptId);
      if (!script) {
        onError(tRef.current("Script not found"));
        return;
      }

      const directCommand = (script.command || "").trim();
      const scriptPath = (script.path || "").trim();
      const resolvedCommand = directCommand || (scriptPath ? `bash ${shellQuote(scriptPath)}` : "");
      if (!resolvedCommand) {
        onError(tRef.current("Script has no runnable command or path"));
        return;
      }

      try {
        await runBusy(tRef.current("Run script"), () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.ptyWriteInput(sessionId, `${resolvedCommand}\n`),
          ),
        );
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, onError, runBusy, runWithSessionReconnect, scripts],
  );

  const sendPtyInput = useCallback(
    (sessionId, data) => {
      if (!sessionId || !data) {
        return;
      }
      const sender = ptyInputSenderRef.current;
      if (sender) {
        sender.enqueue(sessionId, data);
        return;
      }

      const runWithReconnect = runWithSessionReconnectRef.current;
      if (!runWithReconnect) {
        return;
      }
      void runWithReconnect(sessionId, (activeId) => api.ptyWriteInput(activeId, data)).catch((error) => {
        onErrorRef.current(error);
      });
    },
    [],
  );

  const resizePty = useCallback((sessionId, cols, rows) => {
    if (!sessionId || !cols || !rows) {
      return;
    }
    void runWithSessionReconnect(sessionId, (activeId) => api.ptyResize(activeId, cols, rows)).catch(() => {
      // Ignore transient resize failures caused by tab switching.
    });
  }, [runWithSessionReconnect]);

  const saveAiProfile = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        const state = await runBusy(tRef.current("Save AI config"), () =>
          api.saveAiProfile(toAiProfileInput(aiProfileForm)),
        );
        const activeProfile = applyAiProfilesState(state);
        if (activeProfile) {
          setAiProfileForm(activeProfile);
        }
      } catch (err) {
        onError(err);
      }
    },
    [aiProfileForm, applyAiProfilesState, onError, runBusy],
  );

  const selectAiProfile = useCallback(
    async (profileId) => {
      if (!profileId) {
        return;
      }
      try {
        const state = await runBusy(tRef.current("Switch AI profile"), () =>
          api.setActiveAiProfile(profileId),
        );
        applyAiProfilesState(state);
      } catch (err) {
        onError(err);
      }
    },
    [applyAiProfilesState, onError, runBusy],
  );

  const deleteAiProfile = useCallback(
    async (profileId) => {
      if (!profileId) {
        return;
      }
      try {
        const state = await runBusy(tRef.current("Delete AI config"), () =>
          api.deleteAiProfile(profileId),
        );
        applyAiProfilesState(state);
      } catch (err) {
        onError(err);
      }
    },
    [applyAiProfilesState, onError, runBusy],
  );

  const saveAiApprovalMode = useCallback(
    async (approvalMode) => {
      if (approvalMode !== "auto_execute" && approvalMode !== "require_approval") {
        return;
      }
      try {
        const state = await runBusy(tRef.current("Approval mode"), () =>
          api.saveAiApprovalMode(approvalMode),
        );
        applyAiProfilesState(state, true);
      } catch (err) {
        onError(err);
      }
    },
    [applyAiProfilesState, onError, runBusy],
  );

  const selectAiConversation = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        return;
      }
      try {
        await api.opsAgentSetActiveConversation(conversationId);
        setActiveAiConversationId(conversationId);
        await Promise.all([loadAiConversation(conversationId), reloadAiConversations()]);
      } catch (err) {
        onError(err);
      }
    },
    [loadAiConversation, onError, reloadAiConversations],
  );

  const createAiConversation = useCallback(async () => {
    try {
      const created = await runBusy(tRef.current("Create AI conversation"), () =>
        api.opsAgentCreateConversation(null, activeSessionId || null),
      );
      clearAiConversationError(created.id);
      clearAiConversationError(null);
      setActiveAiConversationId(created.id);
      setActiveAiConversation(created);
      setAiQuestion("");
      setAiStream(EMPTY_OPS_AGENT_STREAM);
      aiStreamRef.current = EMPTY_OPS_AGENT_STREAM;
      await Promise.all([
        reloadAiConversations(),
        reloadAiPendingActions(activeSessionId || null),
      ]);
    } catch (err) {
      onError(err);
    }
  }, [
    activeSessionId,
    clearAiConversationError,
    onError,
    reloadAiConversations,
    reloadAiPendingActions,
    runBusy,
  ]);

  const deleteAiConversation = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        return false;
      }
      try {
        await runBusy(tRef.current("Delete AI conversation"), () =>
          api.opsAgentDeleteConversation(conversationId),
        );
        clearAiConversationError(conversationId);
        const conversations = await reloadAiConversations();
        const nextId = conversations[0]?.id || null;
        setActiveAiConversationId(nextId);
        if (nextId) {
          await loadAiConversation(nextId);
        } else {
          setActiveAiConversation(null);
        }
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [clearAiConversationError, loadAiConversation, onError, reloadAiConversations, runBusy],
  );

  const compactAiConversation = useCallback(
    async (conversationId = activeAiConversationId) => {
      if (!conversationId) {
        return false;
      }

      try {
        const result = await runBusy(tRef.current("Compact conversation"), () =>
          api.opsAgentCompactConversation(conversationId),
        );
        if (result?.conversation) {
          setActiveAiConversation(result.conversation);
        } else {
          await loadAiConversation(conversationId);
        }
        await reloadAiConversations();
        pushUiNotice(tRef.current(result?.note || "Conversation compaction finished."), {
          tone: result?.compacted ? "success" : "info",
          ttlMs: 4200,
        });
        return Boolean(result?.compacted);
      } catch (err) {
        onError(err);
        return false;
      }
    },
    [
      activeAiConversationId,
      loadAiConversation,
      onError,
      pushUiNotice,
      reloadAiConversations,
      runBusy,
      setActiveAiConversation,
    ],
  );

  const resolveAiPendingAction = useCallback(
    async (actionId, approve, comment = "") => {
      if (!actionId) {
        return;
      }
      setResolvingAiActionId(actionId);
      try {
        await runBusy(tRef.current(approve ? "Approve command" : "Reject command"), () =>
          api.opsAgentResolveAction(
            actionId,
            approve,
            activeSessionId || null,
            typeof comment === "string" && comment.trim() ? comment.trim() : null,
          ),
        );
        await Promise.all([
          reloadAiPendingActions(activeSessionId || null),
          activeAiConversationId ? loadAiConversation(activeAiConversationId) : Promise.resolve(),
          reloadAiConversations(),
        ]);
      } catch (err) {
        onError(err);
      } finally {
        setResolvingAiActionId("");
      }
    },
    [
      activeAiConversationId,
      activeSessionId,
      loadAiConversation,
      onError,
      reloadAiConversations,
      reloadAiPendingActions,
      runBusy,
    ],
  );

  const askAi = useCallback(
    async (event) => {
      event.preventDefault();
      const question = aiQuestion.trim();
      if (!question || aiStream.runId) {
        return;
      }
      const shellContext = aiShellContext || null;
      try {
        clearAiConversationError(activeAiConversationId || null);
        setAiQuestion("");
        const accepted = await runBusy(tRef.current("AI response"), () =>
          api.opsAgentChatStreamStart({
            conversationId: activeAiConversationId || null,
            sessionId: activeSessionId || null,
            question,
            shellContext,
          }),
        );
        clearAiConversationError(accepted.conversationId || null);
        setAiShellContext(null);
        const nextStream = {
          runId: accepted.runId,
          conversationId: accepted.conversationId,
          text: "",
          toolCalls: [],
        };
        aiStreamRef.current = nextStream;
        setAiStream(nextStream);
        setActiveAiConversationId(accepted.conversationId);
        await Promise.all([
          loadAiConversation(accepted.conversationId),
          reloadAiConversations(),
          reloadAiPendingActions(activeSessionId || null),
        ]);
      } catch (err) {
        setAiQuestion(question);
        setAiConversationError(activeAiConversationId || null, err);
      }
    },
    [
      activeAiConversationId,
      activeSessionId,
      aiShellContext,
      aiQuestion,
      aiStream.runId,
      clearAiConversationError,
      loadAiConversation,
      reloadAiConversations,
      reloadAiPendingActions,
      runBusy,
      setAiConversationError,
    ],
  );

  const cancelAiStreaming = useCallback(async () => {
    const runId = aiStreamRef.current.runId;
    if (!runId) {
      return;
    }
    try {
      await api.opsAgentCancelRun(runId);
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  const handleDeleteSsh = useCallback(
    async (sshId) => {
      try {
        await runBusy(tRef.current("Delete SSH config"), () => api.deleteSshConfig(sshId));
        setSshConfigs(await api.listSshConfigs());
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy],
  );

  const handleDeleteScript = useCallback(
    async (scriptId) => {
      try {
        await runBusy(tRef.current("Delete script"), () => api.deleteScript(scriptId));
        setScripts(await api.listScripts());
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy],
  );

  const handleNicChange = useCallback(
    (nic) => {
      if (!activeSessionId) {
        return;
      }
      const targetSessionId = resolveSessionAlias(activeSessionId) || activeSessionId;
      setNicBySession((prev) => ({ ...prev, [targetSessionId]: nic }));
      refreshStatus(targetSessionId, nic);
    },
    [activeSessionId, refreshStatus, resolveSessionAlias],
  );

  const handleOpenFileContentChange = useCallback((value) => {
    setOpenFileContent(value);
    setDirtyFile(true);
  }, []);

  const handleDownloadDirectoryChange = useCallback(
    (value) => {
      if (typeof value !== "string") {
        return;
      }
      setDownloadDirectory(value.trim());
    },
    [setDownloadDirectory],
  );

  const attachAiShellContext = useCallback((selection) => {
    const attachment = createShellContextAttachment(selection);
    if (!attachment) {
      return;
    }
    setAiShellContext(attachment);
  }, []);

  const clearAiShellContext = useCallback(() => {
    setAiShellContext(null);
  }, []);

  return {
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
    clearAiShellContext,
  };
}
