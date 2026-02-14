import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_AI, EMPTY_SCRIPT, EMPTY_SSH } from "../constants/workbench";
import { api } from "../lib/tauri-api";
import { arrayBufferToBase64, base64ToBytes } from "../utils/encoding";
import { formatBytes } from "../utils/format";
import { joinPath, normalizeRemotePath } from "../utils/path";

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
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiIncludeOutput, setAiIncludeOutput] = useState(true);
  const [aiAnswer, setAiAnswer] = useState(null);

  const saveTimerRef = useRef(null);

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
    const message = typeof err === "string" ? err : err?.message || JSON.stringify(err);
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

  const bootstrap = useCallback(async () => {
    try {
      setBusy("加载项目");
      const [configs, scriptRows, ai, opened] = await Promise.all([
        api.listSshConfigs(),
        api.listScripts(),
        api.getAiConfig(),
        api.listShellSessions(),
      ]);
      setSshConfigs(configs);
      setScripts(scriptRows);
      setAiConfig({
        baseUrl: ai.baseUrl || DEFAULT_AI.baseUrl,
        apiKey: ai.apiKey || "",
        model: ai.model || DEFAULT_AI.model,
        systemPrompt: ai.systemPrompt || DEFAULT_AI.systemPrompt,
        temperature: ai.temperature ?? DEFAULT_AI.temperature,
        maxTokens: ai.maxTokens ?? DEFAULT_AI.maxTokens,
      });
      setSessions(opened);
      if (opened[0]) {
        setActiveSessionId(opened[0].id);
      }
    } catch (err) {
      onError(err);
    } finally {
      setBusy("");
    }
  }, [onError]);

  const reloadSessions = useCallback(async () => {
    const rows = await api.listShellSessions();
    setSessions(rows);
    return rows;
  }, []);

  const saveSsh = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy("保存 SSH 配置", () =>
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
        const session = await runBusy("建立 SSH 连接", () => api.openShellSession(configId));
        await reloadSessions();
        setActiveSessionId(session.id);
        setSftpPath((prev) => ({
          ...prev,
          [session.id]: normalizeRemotePath(session.currentDir || "/"),
        }));
        appendLog(session.id, "SYSTEM", `Connected ${session.configName} (${session.currentDir})`);
      } catch (err) {
        onError(err);
      }
    },
    [appendLog, onError, reloadSessions, runBusy],
  );

  const closeSession = useCallback(
    async (sessionId) => {
      try {
        await runBusy("关闭会话", () => api.closeShellSession(sessionId));
        const rows = await reloadSessions();
        if (activeSessionId === sessionId) {
          setActiveSessionId(rows[0]?.id || null);
        }
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, onError, reloadSessions, runBusy],
  );

  const execCommand = useCallback(
    async (event) => {
      event.preventDefault();
      if (!activeSessionId || !commandInput.trim()) {
        return;
      }
      const command = commandInput;
      setCommandInput("");
      appendLog(activeSessionId, "CMD", command);
      try {
        const result = await runBusy("执行命令", () =>
          api.executeShellCommand(activeSessionId, command),
        );
        appendLog(
          activeSessionId,
          `OUT(${result.exitCode})`,
          [result.stdout, result.stderr].filter(Boolean).join("\n") || "<empty>",
        );
        setSessions((prev) =>
          prev.map((item) =>
            item.id === activeSessionId ? { ...item, currentDir: result.currentDir } : item,
          ),
        );
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, appendLog, commandInput, onError, runBusy],
  );

  const requestSftpDir = useCallback(
    async (path) => {
      if (!activeSessionId) {
        return null;
      }
      try {
        const normalizedPath = normalizeRemotePath(path);
        return await runBusy("读取目录", () => api.sftpListDir(activeSessionId, normalizedPath));
      } catch (err) {
        onError(err);
        return null;
      }
    },
    [activeSessionId, onError, runBusy],
  );

  const refreshSftp = useCallback(
    async (path) => {
      if (!activeSessionId) {
        return null;
      }
      const result = await requestSftpDir(path);
      if (!result) {
        return null;
      }
      setSftpEntries(result.entries);
      setSftpPath((prev) => ({
        ...prev,
        [activeSessionId]: normalizeRemotePath(result.path),
      }));
      setSelectedEntry(null);
      return result;
    },
    [activeSessionId, requestSftpDir],
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
        const file = await runBusy("读取文件", () => api.sftpReadFile(activeSessionId, entry.path));
        setOpenFilePath(normalizeRemotePath(file.path));
        setOpenFileContent(file.content || "");
        setDirtyFile(false);
        return { opened: true, path: normalizeRemotePath(file.path) };
      } catch (err) {
        onError(err);
        return { opened: false };
      }
    },
    [activeSessionId, onError, refreshSftp, runBusy],
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
        await runBusy("上传文件", () => api.sftpUploadFile(activeSessionId, remotePath, contentBase64));
        await refreshSftp(currentPath);
      } catch (err) {
        onError(err);
      } finally {
        event.target.value = "";
      }
    },
    [activeSessionId, currentPath, onError, refreshSftp, runBusy],
  );

  const downloadFile = useCallback(async () => {
    if (!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory") {
      return;
    }
    try {
      const payload = await runBusy("下载文件", () =>
        api.sftpDownloadFile(activeSessionId, normalizeRemotePath(selectedEntry.path)),
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
  }, [activeSessionId, onError, runBusy, selectedEntry]);

  const refreshStatus = useCallback(
    async (sessionId, nic) => {
      if (!sessionId) {
        return;
      }
      try {
        const cached = await api.getCachedServerStatus(sessionId);
        if (cached) {
          setStatusBySession((prev) => ({ ...prev, [sessionId]: cached }));
        }
        const live = await api.fetchServerStatus(sessionId, nic);
        setStatusBySession((prev) => ({ ...prev, [sessionId]: live }));
        if (live.selectedInterface) {
          setNicBySession((prev) => ({ ...prev, [sessionId]: live.selectedInterface }));
        }
      } catch (err) {
        onError(err);
      }
    },
    [onError],
  );

  const saveScript = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        await runBusy("保存脚本", () => api.saveScript(scriptForm));
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
        setError("请先建立 SSH 会话");
        return;
      }
      try {
        const result = await runBusy("执行脚本", () => api.runScript(activeSessionId, scriptId));
        appendLog(
          activeSessionId,
          `SCRIPT:${result.scriptName}`,
          [result.execution.stdout, result.execution.stderr].filter(Boolean).join("\n") || "<empty>",
        );
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, appendLog, onError, runBusy],
  );

  const saveAi = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        const next = await runBusy("保存 AI 配置", () =>
          api.saveAiConfig({
            ...aiConfig,
            temperature: Number(aiConfig.temperature),
            maxTokens: Number(aiConfig.maxTokens),
          }),
        );
        setAiConfig(next);
      } catch (err) {
        onError(err);
      }
    },
    [aiConfig, onError, runBusy],
  );

  const askAi = useCallback(
    async (event) => {
      event.preventDefault();
      if (!aiQuestion.trim()) {
        return;
      }
      try {
        const answer = await runBusy("AI 回答中", () =>
          api.askAi({
            sessionId: activeSessionId || null,
            question: aiQuestion,
            includeLastOutput: aiIncludeOutput,
          }),
        );
        setAiAnswer(answer);
      } catch (err) {
        onError(err);
      }
    },
    [activeSessionId, aiIncludeOutput, aiQuestion, onError, runBusy],
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

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
        await runBusy("正在回传文件", () =>
          api.sftpWriteFile(activeSessionId, openFilePath, openFileContent),
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
  }, [activeSessionId, dirtyFile, onError, openFileContent, openFilePath, runBusy]);

  const currentLogs = activeSessionId ? logs[activeSessionId] || [] : [];

  const handleDeleteSsh = useCallback(
    async (sshId) => {
      try {
        await runBusy("删除 SSH", () => api.deleteSshConfig(sshId));
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
        await runBusy("删除脚本", () => api.deleteScript(scriptId));
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
      setNicBySession((prev) => ({ ...prev, [activeSessionId]: nic }));
      refreshStatus(activeSessionId, nic);
    },
    [activeSessionId, refreshStatus],
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
    currentLogs,
    currentPath,
    currentStatus,
    currentNic,
    sftpEntries,
    selectedEntry,
    openFilePath,
    dirtyFile,
    openFileContent,
    aiConfig,
    setAiConfig,
    aiQuestion,
    setAiQuestion,
    aiIncludeOutput,
    setAiIncludeOutput,
    aiAnswer,
    saveSsh,
    connectServer,
    closeSession,
    execCommand,
    uploadFile,
    downloadFile,
    saveScript,
    runScript,
    saveAi,
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
