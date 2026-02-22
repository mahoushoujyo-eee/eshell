import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_AI, EMPTY_SCRIPT, EMPTY_SSH } from "../constants/workbench";
import { api } from "../lib/tauri-api";
import { arrayBufferToBase64, base64ToBytes } from "../utils/encoding";
import { formatBytes } from "../utils/format";
import { joinPath, normalizeRemotePath } from "../utils/path";

const parseNumber = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const toErrorMessage = (err) =>
  typeof err === "string" ? err : err?.message || JSON.stringify(err);

const STATUS_FETCH_WARNING_PREFIX =
  "Warning: Server status polling failed for this cycle due to a transient network fluctuation. The app will retry automatically.";

const isStatusFetchWarning = (message) =>
  typeof message === "string" && message.startsWith(STATUS_FETCH_WARNING_PREFIX);

const isSessionLostError = (err) => {
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("record not found: shell session") ||
    message.includes("record not found: pty session") ||
    message.includes("pty worker channel closed") ||
    message.includes("pty channel closed while writing")
  );
};

const normalizeAiConfig = (config) => ({
  baseUrl: config?.baseUrl || DEFAULT_AI.baseUrl,
  apiKey: config?.apiKey || "",
  model: config?.model || DEFAULT_AI.model,
  systemPrompt: config?.systemPrompt || DEFAULT_AI.systemPrompt,
  temperature: parseNumber(config?.temperature, DEFAULT_AI.temperature),
  maxTokens: Math.max(1, Math.round(parseNumber(config?.maxTokens, DEFAULT_AI.maxTokens))),
});

const normalizeAiProfile = (profile) => ({
  id: profile?.id || "",
  name: (profile?.name || "").trim() || "Default",
  ...normalizeAiConfig(profile),
});

const toAiProfileInput = (profile) => ({
  id: profile.id || null,
  name: (profile.name || "").trim(),
  baseUrl: profile.baseUrl,
  apiKey: profile.apiKey,
  model: profile.model,
  systemPrompt: profile.systemPrompt,
  temperature: Number(profile.temperature),
  maxTokens: Number(profile.maxTokens),
});

const normalizeAiProfilesState = (state) => {
  const profiles = Array.isArray(state?.profiles)
    ? state.profiles.map(normalizeAiProfile).filter((item) => item.id)
    : [];
  const activeFromState = state?.activeProfileId || null;
  const activeProfileId =
    activeFromState && profiles.some((item) => item.id === activeFromState)
      ? activeFromState
      : profiles[0]?.id || null;
  return {
    profiles,
    activeProfileId,
  };
};

const DEFAULT_AI_PROFILE_FORM = {
  id: null,
  name: "Default",
  ...DEFAULT_AI,
};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
const emptyAiStream = Object.freeze({
  runId: null,
  conversationId: null,
  text: "",
});

const TERMINAL_MAX_OUTPUT_CHARS = 240_000;

const trimTerminalOutput = (value) => {
  if (value.length <= TERMINAL_MAX_OUTPUT_CHARS) {
    return value;
  }
  return value.slice(value.length - TERMINAL_MAX_OUTPUT_CHARS);
};

const upsertPendingAction = (rows, nextAction) => {
  if (!nextAction?.id) {
    return rows;
  }
  const index = rows.findIndex((item) => item.id === nextAction.id);
  if (index === -1) {
    return [nextAction, ...rows];
  }
  const next = [...rows];
  next[index] = nextAction;
  return next;
};

export function useWorkbench() {
  const [theme, setTheme] = useState("light");
  const [wallpaper, setWallpaper] = useState(1);
  const [showSftpPanel, setShowSftpPanel] = useState(true);
  const [showStatusPanel, setShowStatusPanel] = useState(true);
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const [sshConfigs, setSshConfigs] = useState([]);
  const [sshForm, setSshForm] = useState(EMPTY_SSH);

  const [scripts, setScripts] = useState([]);
  const [scriptForm, setScriptForm] = useState(EMPTY_SCRIPT);

  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [logs, setLogs] = useState({});
  const [ptyOutputBySession, setPtyOutputBySession] = useState({});
  const [commandInput, setCommandInput] = useState("");

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
  const [aiConversations, setAiConversations] = useState([]);
  const [activeAiConversationId, setActiveAiConversationId] = useState(null);
  const [activeAiConversation, setActiveAiConversation] = useState(null);
  const [aiPendingActions, setAiPendingActions] = useState([]);
  const [aiStream, setAiStream] = useState(emptyAiStream);
  const [resolvingAiActionId, setResolvingAiActionId] = useState("");

  const saveTimerRef = useRef(null);
  const reconnectingSessionsRef = useRef(new Map());
  const sessionAliasRef = useRef(new Map());
  const statusRequestTokenRef = useRef(new Map());

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
    const message = toErrorMessage(err);
    setError(message);
  }, []);

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
            ts: new Date().toLocaleTimeString(),
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
    sessionAliasRef.current.forEach((value, key) => {
      if (key === sessionId || value === sessionId) {
        aliasKeys.push(key);
      }
    });
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
        throw new Error("No shell session selected");
      }

      const existing = reconnectingSessionsRef.current.get(originSessionId);
      if (existing) {
        return existing;
      }

      const task = (async () => {
        const staleSession = sessions.find((item) => item.id === originSessionId);
        if (!staleSession?.configId) {
          throw new Error(`Shell session lost and cannot auto-reconnect: ${originSessionId}`);
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

        appendLog(reopened.id, "SYSTEM", "Session disconnected. Auto-reconnected.");
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
        throw new Error("No shell session selected");
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

  const applyAiProfilesState = useCallback((state, keepForm = false) => {
    const normalized = normalizeAiProfilesState(state);
    setAiProfiles(normalized.profiles);
    setActiveAiProfileId(normalized.activeProfileId);

    const activeProfile =
      normalized.profiles.find((item) => item.id === normalized.activeProfileId) || null;
    if (activeProfile) {
      setAiConfig(normalizeAiConfig(activeProfile));
      if (!keepForm) {
        setAiProfileForm(activeProfile);
      }
      return activeProfile;
    }

    setAiConfig(DEFAULT_AI);
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
      setBusy("Loading project");
      const [configs, scriptRows, aiProfilesState, opened, conversations, pendingActions] = await Promise.all([
        api.listSshConfigs(),
        api.listScripts(),
        api.listAiProfiles(),
        api.listShellSessions(),
        api.opsAgentListConversations(),
        api.opsAgentListPendingActions(null, true),
      ]);
      setSshConfigs(configs);
      setScripts(scriptRows);
      applyAiProfilesState(aiProfilesState);
      setAiConversations(conversations);
      setAiPendingActions(pendingActions);

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
    } catch (err) {
      onError(err);
    } finally {
      setBusy("");
    }
  }, [applyAiProfilesState, onError]);

  const reloadSessions = useCallback(async () => {
    const rows = await api.listShellSessions();
    setSessions(rows);
    return rows;
  }, []);

  const saveSsh = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy("Save SSH config", () =>
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
      } catch (err) {
        onError(err);
      }
    },
    [onError, runBusy, sshForm],
  );

  const connectServer = useCallback(
    async (configId) => {
      try {
        const session = await runBusy("Open SSH session", () => api.openShellSession(configId));
        await reloadSessions();
        setActiveSessionId(session.id);
        setSftpPath((prev) => ({
          ...prev,
          [session.id]: normalizeRemotePath(session.currentDir || "/"),
        }));
        setPtyOutputBySession((prev) => ({ ...prev, [session.id]: "" }));
        appendLog(session.id, "SYSTEM", `Connected ${session.configName} (${session.currentDir})`);
      } catch (err) {
        onError(err);
      }
    },
    [appendLog, onError, reloadSessions, runBusy],
  );

  const closeSession = useCallback(
    async (sessionId) => {
      if (!sessionId) {
        return;
      }
      const resolvedSessionId = resolveSessionAlias(sessionId);
      let rows = null;
      try {
        await runBusy("Close session", () => api.closeShellSession(resolvedSessionId));
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
        return await runBusy("Read directory", () =>
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
        const file = await runBusy("Read file", () =>
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

  const uploadFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file || !activeSessionId) {
        return;
      }
      try {
        const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const remotePath = joinPath(currentPath, file.name);
        await runBusy("Upload file", () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.sftpUploadFile(sessionId, remotePath, contentBase64),
          ),
        );
        await refreshSftp(currentPath);
      } catch (err) {
        onError(err);
      } finally {
        event.target.value = "";
      }
    },
    [activeSessionId, currentPath, onError, refreshSftp, runBusy, runWithSessionReconnect],
  );

  const downloadFile = useCallback(async () => {
    if (!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory") {
      return;
    }
    try {
      const payload = await runBusy("Download file", () =>
        runWithSessionReconnect(activeSessionId, (sessionId) =>
          api.sftpDownloadFile(sessionId, normalizeRemotePath(selectedEntry.path)),
        ),
      );
      const url = URL.createObjectURL(new Blob([base64ToBytes(payload.contentBase64)]));
      const link = document.createElement("a");
      link.href = url;
      link.download = payload.fileName || "download.bin";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, onError, runBusy, runWithSessionReconnect, selectedEntry]);

  const refreshStatus = useCallback(
    async (sessionId, nic) => {
      if (!sessionId) {
        return;
      }
      const resolvedSessionId = resolveSessionAlias(sessionId) || sessionId;
      const requestedNic = typeof nic === "string" && nic.trim() ? nic : null;
      const requestToken = Symbol(resolvedSessionId);
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
          return isStatusFetchWarning(current) ? "" : prev;
        });
      } catch (err) {
        setError((prev) => {
          const current = typeof prev === "string" ? prev.trim() : "";
          if (current && !isStatusFetchWarning(current)) {
            return prev;
          }
          return STATUS_FETCH_WARNING_PREFIX;
        });
      }
    },
    [resolveSessionAlias, runWithSessionReconnect],
  );

  const saveScript = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy("Save script", () => api.saveScript(scriptForm));
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
        setError("Please connect an SSH session first");
        return;
      }

      const script = scripts.find((item) => item.id === scriptId);
      if (!script) {
        setError("Script not found");
        return;
      }

      const directCommand = (script.command || "").trim();
      const scriptPath = (script.path || "").trim();
      const resolvedCommand = directCommand || (scriptPath ? `bash ${shellQuote(scriptPath)}` : "");
      if (!resolvedCommand) {
        setError("Script has no runnable command or path");
        return;
      }

      try {
        await runBusy("Run script", () =>
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
      void runWithSessionReconnect(sessionId, (activeId) => api.ptyWriteInput(activeId, data)).catch(
        onError,
      );
    },
    [onError, runWithSessionReconnect],
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
        const state = await runBusy("Save AI config", () =>
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
        const state = await runBusy("Switch AI profile", () =>
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
        const state = await runBusy("Delete AI config", () =>
          api.deleteAiProfile(profileId),
        );
        applyAiProfilesState(state);
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
      const created = await runBusy("Create AI conversation", () =>
        api.opsAgentCreateConversation(null, activeSessionId || null),
      );
      setActiveAiConversationId(created.id);
      setActiveAiConversation(created);
      setAiQuestion("");
      setAiStream(emptyAiStream);
      await Promise.all([
        reloadAiConversations(),
        reloadAiPendingActions(activeSessionId || null),
      ]);
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, onError, reloadAiConversations, reloadAiPendingActions, runBusy]);

  const deleteAiConversation = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        return;
      }
      try {
        await runBusy("Delete AI conversation", () =>
          api.opsAgentDeleteConversation(conversationId),
        );
        const conversations = await reloadAiConversations();
        const nextId = conversations[0]?.id || null;
        setActiveAiConversationId(nextId);
        if (nextId) {
          await loadAiConversation(nextId);
        } else {
          setActiveAiConversation(null);
        }
      } catch (err) {
        onError(err);
      }
    },
    [loadAiConversation, onError, reloadAiConversations, runBusy],
  );

  const resolveAiPendingAction = useCallback(
    async (actionId, approve) => {
      if (!actionId) {
        return;
      }
      setResolvingAiActionId(actionId);
      try {
        await runBusy(approve ? "Approve command" : "Reject command", () =>
          api.opsAgentResolveAction(actionId, approve),
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
      try {
        setAiQuestion("");
        const accepted = await runBusy("AI response", () =>
          api.opsAgentChatStreamStart({
            conversationId: activeAiConversationId || null,
            sessionId: activeSessionId || null,
            question,
          }),
        );
        setAiStream({
          runId: accepted.runId,
          conversationId: accepted.conversationId,
          text: "",
        });
        setActiveAiConversationId(accepted.conversationId);
        await Promise.all([
          loadAiConversation(accepted.conversationId),
          reloadAiConversations(),
          reloadAiPendingActions(activeSessionId || null),
        ]);
      } catch (err) {
        setAiQuestion(question);
        onError(err);
      }
    },
    [
      activeAiConversationId,
      activeSessionId,
      aiQuestion,
      aiStream.runId,
      loadAiConversation,
      onError,
      reloadAiConversations,
      reloadAiPendingActions,
      runBusy,
    ],
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen("pty-output", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") {
        return;
      }
      const sessionId = payload.sessionId;
      const chunk = payload.chunk;
      if (typeof sessionId !== "string" || typeof chunk !== "string" || !chunk) {
        return;
      }
      appendPtyOutput(sessionId, chunk);
    }).catch((error) => {
      if (!disposed) {
        console.warn("Failed to bind PTY output listener", error);
      }
      return null;
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => {
        if (typeof unlisten === "function") {
          unlisten();
        }
      });
    };
  }, [appendPtyOutput]);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen("ops-agent-stream", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") {
        return;
      }

      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const conversationId =
        typeof payload.conversationId === "string" ? payload.conversationId : "";
      const stage = typeof payload.stage === "string" ? payload.stage : "";
      const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
      const errorMessage = typeof payload.error === "string" ? payload.error : "";
      const pendingAction =
        payload.pendingAction && typeof payload.pendingAction === "object"
          ? payload.pendingAction
          : null;

      if (!stage) {
        return;
      }

      if (stage === "error" && (!runId || !conversationId)) {
        setAiStream(emptyAiStream);
        if (errorMessage) {
          onError(errorMessage);
        }
        return;
      }

      if (!runId || !conversationId) {
        return;
      }

      if (stage === "started") {
        setAiStream({ runId, conversationId, text: "" });
        setActiveAiConversationId(conversationId);
        return;
      }

      if (stage === "delta") {
        setAiStream((prev) => {
          if (prev.runId === runId) {
            return { ...prev, text: `${prev.text}${chunk}` };
          }
          return { runId, conversationId, text: chunk };
        });
        return;
      }

      if (stage === "tool_read") {
        void loadAiConversation(conversationId).catch(() => {});
        return;
      }

      if (stage === "requires_approval") {
        if (pendingAction) {
          setAiPendingActions((prev) => upsertPendingAction(prev, pendingAction));
        }
        return;
      }

      if (stage === "completed") {
        setAiStream((prev) => (prev.runId === runId ? emptyAiStream : prev));
        if (pendingAction) {
          setAiPendingActions((prev) => upsertPendingAction(prev, pendingAction));
        }
        void Promise.all([
          loadAiConversation(conversationId),
          reloadAiConversations(),
          reloadAiPendingActions(activeSessionId || null),
        ]).catch(() => {});
        return;
      }

      if (stage === "error") {
        setAiStream((prev) => (prev.runId === runId ? emptyAiStream : prev));
        if (errorMessage) {
          onError(errorMessage);
        }
      }
    }).catch((error) => {
      if (!disposed) {
        console.warn("Failed to bind ops-agent-stream listener", error);
      }
      return null;
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => {
        if (typeof unlisten === "function") {
          unlisten();
        }
      });
    };
  }, [
    activeSessionId,
    loadAiConversation,
    onError,
    reloadAiConversations,
    reloadAiPendingActions,
  ]);

  useEffect(() => {
    if (!activeAiConversationId) {
      setActiveAiConversation(null);
      return;
    }
    void loadAiConversation(activeAiConversationId).catch(onError);
  }, [activeAiConversationId, loadAiConversation, onError]);

  useEffect(() => {
    void reloadAiPendingActions(activeSessionId || null).catch(() => {});
  }, [activeSessionId, reloadAiPendingActions]);

  useEffect(() => {
    if (!activeSessionId) {
      setSftpEntries([]);
      setOpenFilePath("");
      setOpenFileContent("");
      setDirtyFile(false);
      return undefined;
    }

    refreshSftp(currentPath);
    refreshStatus(activeSessionId, currentNic);

    const timer = setInterval(() => {
      refreshStatus(activeSessionId, currentNic);
    }, 5000);
    return () => clearInterval(timer);
  }, [activeSessionId, currentPath, currentNic, refreshSftp, refreshStatus]);

  useEffect(() => {
    if (!activeSessionId || !openFilePath || !dirtyFile) {
      return undefined;
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(async () => {
      try {
        await runBusy("Save edited file", () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
            api.sftpWriteFile(sessionId, openFilePath, openFileContent),
          ),
        );
        setDirtyFile(false);
      } catch (err) {
        onError(err);
      }
    }, 700);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    activeSessionId,
    dirtyFile,
    onError,
    openFileContent,
    openFilePath,
    runBusy,
    runWithSessionReconnect,
  ]);

  const currentPtyOutput = activeSessionId ? ptyOutputBySession[activeSessionId] || "" : "";
  const aiStreamingText =
    aiStream.conversationId === activeAiConversationId ? aiStream.text : "";
  const isAiStreaming =
    Boolean(aiStream.runId) && aiStream.conversationId === activeAiConversationId;

  const handleDeleteSsh = useCallback(
    async (sshId) => {
      try {
        await runBusy("Delete SSH config", () => api.deleteSshConfig(sshId));
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
        await runBusy("Delete script", () => api.deleteScript(scriptId));
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
    aiConversations,
    activeAiConversationId,
    activeAiConversation,
    aiPendingActions,
    isAiStreaming,
    aiStreamingText,
    resolvingAiActionId,
    saveSsh,
    connectServer,
    closeSession,
    execCommand,
    sendPtyInput,
    resizePty,
    uploadFile,
    downloadFile,
    saveScript,
    runScript,
    saveAiProfile,
    selectAiProfile,
    deleteAiProfile,
    selectAiConversation,
    createAiConversation,
    deleteAiConversation,
    resolveAiPendingAction,
    askAi,
    requestSftpDir,
    refreshSftp,
    openEntry,
    handleDeleteSsh,
    handleDeleteScript,
    handleNicChange,
    handleOpenFileContentChange,
    formatBytes,
  };
}
