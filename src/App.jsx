import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SplitPane from "./components/SplitPane";
import { api } from "./lib/tauri-api";

const WALLPAPERS = [
  "none",
  "radial-gradient(circle at 14% 14%, rgba(87, 176, 149, 0.22), transparent 26%), radial-gradient(circle at 87% 21%, rgba(201, 154, 90, 0.18), transparent 38%)",
  "linear-gradient(115deg, rgba(12, 40, 36, 0.45), rgba(147, 99, 64, 0.24))",
];

const EMPTY_SSH = {
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  password: "",
  description: "",
};

const EMPTY_SCRIPT = {
  id: null,
  name: "",
  path: "",
  command: "",
  description: "",
};

const DEFAULT_AI = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.",
  temperature: 0.2,
  maxTokens: 800,
};

function App() {
  const [theme, setTheme] = useState("light");
  const [wallpaper, setWallpaper] = useState(1);
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState(true);
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
    () => (activeSession ? sftpPath[activeSession.id] || activeSession.currentDir || "/" : "/"),
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

  const saveSsh = useCallback(async (event) => {
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
  }, [sshForm, runBusy, onError]);

  const connectServer = useCallback(async (configId) => {
    try {
      const session = await runBusy("建立 SSH 连接", () => api.openShellSession(configId));
      await reloadSessions();
      setActiveSessionId(session.id);
      setSftpPath((prev) => ({ ...prev, [session.id]: session.currentDir || "/" }));
      appendLog(session.id, "SYSTEM", `Connected ${session.configName} (${session.currentDir})`);
    } catch (err) {
      onError(err);
    }
  }, [appendLog, onError, reloadSessions, runBusy]);

  const closeSession = useCallback(async (sessionId) => {
    try {
      await runBusy("关闭会话", () => api.closeShellSession(sessionId));
      const rows = await reloadSessions();
      if (activeSessionId === sessionId) {
        setActiveSessionId(rows[0]?.id || null);
      }
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, onError, reloadSessions, runBusy]);

  const execCommand = useCallback(async (event) => {
    event.preventDefault();
    if (!activeSessionId || !commandInput.trim()) {
      return;
    }
    const command = commandInput;
    setCommandInput("");
    appendLog(activeSessionId, "CMD", command);
    try {
      const result = await runBusy("执行命令", () => api.executeShellCommand(activeSessionId, command));
      appendLog(activeSessionId, `OUT(${result.exitCode})`, [result.stdout, result.stderr].filter(Boolean).join("\n") || "<empty>");
      setSessions((prev) => prev.map((item) => item.id === activeSessionId ? { ...item, currentDir: result.currentDir } : item));
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, commandInput, appendLog, runBusy, onError]);

  const refreshSftp = useCallback(async (path) => {
    if (!activeSessionId) {
      return;
    }
    try {
      const result = await runBusy("读取目录", () => api.sftpListDir(activeSessionId, path));
      setSftpEntries(result.entries);
      setSftpPath((prev) => ({ ...prev, [activeSessionId]: result.path }));
      setSelectedEntry(null);
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, runBusy, onError]);

  const openEntry = useCallback(async (entry) => {
    if (!activeSessionId) {
      return;
    }
    setSelectedEntry(entry);
    if (entry.entryType === "directory") {
      await refreshSftp(entry.path);
      return;
    }
    try {
      const file = await runBusy("读取文件", () => api.sftpReadFile(activeSessionId, entry.path));
      setOpenFilePath(file.path);
      setOpenFileContent(file.content || "");
      setDirtyFile(false);
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, runBusy, refreshSftp, onError]);

  const uploadFile = useCallback(async (event) => {
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
  }, [activeSessionId, currentPath, runBusy, refreshSftp, onError]);

  const downloadFile = useCallback(async () => {
    if (!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory") {
      return;
    }
    try {
      const payload = await runBusy("下载文件", () => api.sftpDownloadFile(activeSessionId, selectedEntry.path));
      const url = URL.createObjectURL(new Blob([base64ToBytes(payload.contentBase64)]));
      const link = document.createElement("a");
      link.href = url;
      link.download = payload.fileName || "download.bin";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, selectedEntry, runBusy, onError]);

  const refreshStatus = useCallback(async (sessionId, nic) => {
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
  }, [onError]);

  const saveScript = useCallback(async (event) => {
    event.preventDefault();
    try {
      await runBusy("保存脚本", () => api.saveScript(scriptForm));
      setScriptForm(EMPTY_SCRIPT);
      setScripts(await api.listScripts());
    } catch (err) {
      onError(err);
    }
  }, [scriptForm, runBusy, onError]);

  const runScript = useCallback(async (scriptId) => {
    if (!activeSessionId) {
      setError("请先建立 SSH 会话");
      return;
    }
    try {
      const result = await runBusy("执行脚本", () => api.runScript(activeSessionId, scriptId));
      appendLog(activeSessionId, `SCRIPT:${result.scriptName}`, [result.execution.stdout, result.execution.stderr].filter(Boolean).join("\n") || "<empty>");
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, runBusy, appendLog, onError]);

  const saveAi = useCallback(async (event) => {
    event.preventDefault();
    try {
      const next = await runBusy("保存 AI 配置", () => api.saveAiConfig({
        ...aiConfig,
        temperature: Number(aiConfig.temperature),
        maxTokens: Number(aiConfig.maxTokens),
      }));
      setAiConfig(next);
    } catch (err) {
      onError(err);
    }
  }, [aiConfig, runBusy, onError]);

  const askAi = useCallback(async (event) => {
    event.preventDefault();
    if (!aiQuestion.trim()) {
      return;
    }
    try {
      const answer = await runBusy("AI 回答中", () => api.askAi({
        sessionId: activeSessionId || null,
        question: aiQuestion,
        includeLastOutput: aiIncludeOutput,
      }));
      setAiAnswer(answer);
    } catch (err) {
      onError(err);
    }
  }, [activeSessionId, aiQuestion, aiIncludeOutput, runBusy, onError]);

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
  }, [activeSessionId, openFilePath, openFileContent, dirtyFile, runBusy, onError]);

  const segments = splitPath(currentPath);
  const currentLogs = activeSessionId ? logs[activeSessionId] || [] : [];

  return (
    <div className="h-full w-full p-3 text-text lg:p-4">
      <div className="flex h-full flex-col gap-3">
        <header className="panel-card flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-sm font-semibold tracking-[0.2em] text-muted uppercase">eShell</div>
            <div className="text-lg font-semibold">FinalShell 风格运维工作台</div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
              onClick={() => setIsLeftDrawerOpen((prev) => !prev)}
            >
              {isLeftDrawerOpen ? "收起侧栏" : "展开侧栏"}
            </button>
            <button type="button" className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm" onClick={() => setWallpaper((prev) => (prev + 1) % WALLPAPERS.length)}>壁纸 {wallpaper + 1}</button>
            <button type="button" className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm" onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}>{theme === "light" ? "夜间模式" : "白天模式"}</button>
          </div>
        </header>

        <div className="panel-card relative min-h-0 flex-1 overflow-hidden">
          {!isLeftDrawerOpen && (
            <button
              type="button"
              className="absolute top-1/2 left-0 z-20 -translate-y-1/2 rounded-r-md border border-border bg-surface px-1.5 py-3 text-xs text-muted shadow"
              onClick={() => setIsLeftDrawerOpen(true)}
              title="展开左侧抽屉"
            >
              {">"}
            </button>
          )}
          <SplitPane
            direction="horizontal"
            initialRatio={0.28}
            minPrimarySize={320}
            minSecondarySize={640}
            collapsed={!isLeftDrawerOpen}
            collapsedPrimarySize={0}
            primary={
              <aside className={["h-full overflow-auto p-3 transition-opacity duration-200", isLeftDrawerOpen ? "opacity-100" : "pointer-events-none opacity-0"].join(" ")}>
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted hover:bg-accent-soft"
                    onClick={() => setIsLeftDrawerOpen(false)}
                  >
                    收起
                  </button>
                </div>
                <section className="mb-3 rounded-xl border border-border/80 bg-panel p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">SSH 连接</h2>
                    <span className="rounded bg-accent-soft px-2 py-0.5 text-xs text-muted">{sshConfigs.length}</span>
                  </div>
                  <div className="max-h-42 space-y-2 overflow-auto">
                    {sshConfigs.map((item) => (
                      <div key={item.id} className="rounded border border-border/70 bg-surface px-2 py-2 text-xs">
                        <div className="font-medium">{item.name}</div>
                        <div className="text-muted">{item.username}@{item.host}:{item.port}</div>
                        <div className="mt-2 flex gap-1">
                          <button type="button" className="rounded bg-accent px-2 py-1 text-white" onClick={() => connectServer(item.id)}>连接</button>
                          <button type="button" className="rounded border border-border px-2 py-1" onClick={() => setSshForm(item)}>编辑</button>
                          <button type="button" className="rounded border border-danger/40 px-2 py-1 text-danger" onClick={async () => {
                            await runBusy("删除 SSH", () => api.deleteSshConfig(item.id));
                            setSshConfigs(await api.listSshConfigs());
                          }}>删除</button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <form className="mt-3 space-y-2" onSubmit={saveSsh}>
                    <div className="grid grid-cols-2 gap-2">
                      <input className="rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="名称" value={sshForm.name} onChange={(e) => setSshForm((prev) => ({ ...prev, name: e.target.value }))} />
                      <input className="rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="主机" value={sshForm.host} onChange={(e) => setSshForm((prev) => ({ ...prev, host: e.target.value }))} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input className="rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="端口" value={sshForm.port} onChange={(e) => setSshForm((prev) => ({ ...prev, port: e.target.value }))} />
                      <input className="rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="用户名" value={sshForm.username} onChange={(e) => setSshForm((prev) => ({ ...prev, username: e.target.value }))} />
                    </div>
                    <input type="password" className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="密码" value={sshForm.password} onChange={(e) => setSshForm((prev) => ({ ...prev, password: e.target.value }))} />
                    <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">{sshForm.id ? "更新" : "新增"}</button>
                  </form>
                </section>

                <section className="mb-3 rounded-xl border border-border/80 bg-panel p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">脚本管理</h2>
                    <span className="rounded bg-accent-soft px-2 py-0.5 text-xs text-muted">{scripts.length}</span>
                  </div>
                  <div className="max-h-32 space-y-2 overflow-auto">
                    {scripts.map((item) => (
                      <div key={item.id} className="rounded border border-border/70 bg-surface px-2 py-2 text-xs">
                        <div className="font-medium">{item.name}</div>
                        <div className="truncate text-muted">{item.command || item.path}</div>
                        <div className="mt-2 flex gap-1">
                          <button type="button" className="rounded bg-accent px-2 py-1 text-white" onClick={() => runScript(item.id)}>运行</button>
                          <button type="button" className="rounded border border-border px-2 py-1" onClick={() => setScriptForm(item)}>编辑</button>
                          <button type="button" className="rounded border border-danger/40 px-2 py-1 text-danger" onClick={async () => {
                            await runBusy("删除脚本", () => api.deleteScript(item.id));
                            setScripts(await api.listScripts());
                          }}>删除</button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <form className="mt-3 space-y-2" onSubmit={saveScript}>
                    <input className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="脚本名称" value={scriptForm.name} onChange={(e) => setScriptForm((prev) => ({ ...prev, name: e.target.value }))} />
                    <input className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="脚本路径" value={scriptForm.path} onChange={(e) => setScriptForm((prev) => ({ ...prev, path: e.target.value }))} />
                    <input className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="执行命令" value={scriptForm.command} onChange={(e) => setScriptForm((prev) => ({ ...prev, command: e.target.value }))} />
                    <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">{scriptForm.id ? "更新" : "新增"}</button>
                  </form>
                </section>

                <section className="rounded-xl border border-border/80 bg-panel p-3">
                  <h2 className="mb-2 text-sm font-semibold">AI 配置</h2>
                  <form className="space-y-2" onSubmit={saveAi}>
                    <input className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="Base URL" value={aiConfig.baseUrl} onChange={(e) => setAiConfig((prev) => ({ ...prev, baseUrl: e.target.value }))} />
                    <input type="password" className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="API Key" value={aiConfig.apiKey} onChange={(e) => setAiConfig((prev) => ({ ...prev, apiKey: e.target.value }))} />
                    <div className="grid grid-cols-2 gap-2">
                      <input className="rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="Model" value={aiConfig.model} onChange={(e) => setAiConfig((prev) => ({ ...prev, model: e.target.value }))} />
                      <input className="rounded border border-border bg-surface px-2 py-1.5 text-sm" placeholder="Temp" value={aiConfig.temperature} onChange={(e) => setAiConfig((prev) => ({ ...prev, temperature: e.target.value }))} />
                    </div>
                    <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">保存 AI 配置</button>
                  </form>
                </section>
              </aside>
            }
            secondary={
              <SplitPane
                direction="vertical"
                initialRatio={0.5}
                minPrimarySize={290}
                minSecondarySize={280}
                primary={
                  <section className="h-full p-3">
                    <div className="h-full rounded-xl border border-border/90 bg-panel p-2">
                      <header className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 gap-1 overflow-auto rounded-lg bg-warm p-1">
                          {sessions.map((session) => (
                            <div key={session.id} className={["group flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs", activeSessionId === session.id ? "bg-accent text-white" : "bg-surface text-text"].join(" ")}>
                              <button type="button" className="truncate" onClick={() => setActiveSessionId(session.id)}>{session.configName}</button>
                              <button type="button" className="rounded px-1" onClick={() => closeSession(session.id)}>×</button>
                            </div>
                          ))}
                          {sessions.length === 0 && <div className="px-2 py-1 text-xs text-muted">暂无活跃会话</div>}
                        </div>
                        {activeSession && <div className="rounded bg-accent-soft px-2 py-1 text-xs text-muted">{activeSession.currentDir}</div>}
                      </header>

                      <form className="mb-2 flex gap-2" onSubmit={execCommand}>
                        <input className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm" placeholder={activeSession ? "输入远程命令" : "请先建立会话"} value={commandInput} disabled={!activeSession} onChange={(e) => setCommandInput(e.target.value)} />
                        <button type="submit" disabled={!activeSession} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40">执行</button>
                      </form>

                      <div className="terminal-wallpaper h-[calc(100%-5.5rem)] overflow-auto rounded-md border border-border bg-[#111b19] p-3 font-mono text-xs text-[#d6f6dc]" style={{ backgroundImage: wallpaper === 0 ? undefined : `${WALLPAPERS[wallpaper]}, linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,.6))` }}>
                        {currentLogs.map((row) => (
                          <div key={row.id} className="mb-2">
                            <div className="mb-1 text-[10px] text-[#8ca799]">[{row.ts}] {row.tag}</div>
                            <pre className="whitespace-pre-wrap break-words">{row.text}</pre>
                          </div>
                        ))}
                        {currentLogs.length === 0 && <div className="text-[#93b9a2]">终端输出显示区域</div>}
                      </div>
                    </div>
                  </section>
                }
                secondary={
                  <section className="h-full p-3 pt-0">
                    <SplitPane
                      direction="horizontal"
                      initialRatio={0.58}
                      minPrimarySize={420}
                      minSecondarySize={280}
                      primary={
                        <div className="h-full rounded-xl border border-border/90 bg-panel p-2">
                          <div className="mb-2 flex items-center justify-between">
                            <div className="text-sm font-semibold">SFTP 浏览与编辑</div>
                            <div className="flex gap-1 text-xs">
                              <button type="button" className="rounded border border-border px-2 py-1" onClick={() => refreshSftp(currentPath)} disabled={!activeSessionId}>刷新</button>
                              <label className="cursor-pointer rounded border border-border px-2 py-1">上传<input type="file" className="hidden" onChange={uploadFile} disabled={!activeSessionId} /></label>
                              <button type="button" className="rounded border border-border px-2 py-1" onClick={downloadFile} disabled={!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory"}>下载</button>
                            </div>
                          </div>
                          <SplitPane
                            direction="horizontal"
                            initialRatio={0.33}
                            minPrimarySize={150}
                            minSecondarySize={220}
                            primary={<div className="h-full rounded-md border border-border/80 bg-surface p-2 text-xs" onContextMenu={(event) => { event.preventDefault(); refreshSftp(currentPath); }}>{segments.map((seg) => <button key={seg.path} type="button" className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent-soft" onClick={() => refreshSftp(seg.path)}>{seg.label}</button>)}</div>}
                            secondary={<div className="h-full overflow-hidden text-xs"><div className="mb-1 rounded-md border border-border/80 bg-surface px-2 py-1 text-muted">路径: {currentPath}</div><div className="h-[38%] overflow-auto rounded-md border border-border/80 bg-surface">{sftpEntries.map((entry) => <button key={entry.path} type="button" className={["flex w-full items-center justify-between border-b border-border/50 px-2 py-1.5 text-left hover:bg-accent-soft", selectedEntry?.path === entry.path ? "bg-accent-soft" : ""].join(" ")} onClick={() => openEntry(entry)}><span className="truncate">{entry.entryType === "directory" ? "📁" : "📄"} {entry.name}</span><span className="text-[10px] text-muted">{entry.entryType === "directory" ? "-" : formatBytes(entry.size)}</span></button>)}</div><div className="mt-1 h-[calc(62%-0.25rem)] overflow-hidden rounded-md border border-border/80 bg-surface p-1"><div className="mb-1 text-[10px] text-muted">{openFilePath || "未选择文件"} {dirtyFile ? "(未保存)" : ""}</div><textarea className="h-[calc(100%-1.2rem)] w-full resize-none rounded border border-border bg-panel px-2 py-1 font-mono text-xs" value={openFileContent} disabled={!openFilePath} onChange={(event) => { setOpenFileContent(event.target.value); setDirtyFile(true); }} /></div></div>}
                          />
                        </div>
                      }
                      secondary={
                        <SplitPane
                          direction="vertical"
                          initialRatio={0.55}
                          minPrimarySize={220}
                          minSecondarySize={220}
                          primary={<div className="h-full rounded-xl border border-border/90 bg-panel p-2 text-xs"><div className="mb-2 flex items-center justify-between"><div className="text-sm font-semibold">服务器状态</div>{currentStatus?.fetchedAt && <span className="text-muted">{new Date(currentStatus.fetchedAt).toLocaleTimeString()}</span>}</div>{currentStatus && <><div className="mb-2 rounded border border-border/80 bg-surface p-2"><div className="mb-1 flex justify-between"><span>CPU</span><span>{currentStatus.cpuPercent.toFixed(2)}%</span></div><div className="h-2 rounded bg-warm"><div className="h-full rounded bg-accent" style={{ width: `${Math.min(currentStatus.cpuPercent, 100)}%` }} /></div><div className="mt-2 mb-1 flex justify-between"><span>内存</span><span>{currentStatus.memory.usedMb.toFixed(1)} / {currentStatus.memory.totalMb.toFixed(1)} MB</span></div><div className="h-2 rounded bg-warm"><div className="h-full rounded bg-success" style={{ width: `${Math.min(currentStatus.memory.usedPercent, 100)}%` }} /></div></div><div className="mb-2 rounded border border-border/80 bg-surface p-2"><div className="mb-1 flex items-center justify-between"><span>网卡</span><select className="rounded border border-border bg-panel px-1 py-0.5" value={currentNic || ""} onChange={(event) => { const nic = event.target.value || null; if (!activeSessionId) return; setNicBySession((prev) => ({ ...prev, [activeSessionId]: nic })); refreshStatus(activeSessionId, nic); }}>{(currentStatus.networkInterfaces || []).map((nic) => <option key={nic.interface} value={nic.interface}>{nic.interface}</option>)}</select></div>{currentStatus.selectedInterfaceTraffic && <div className="text-muted">RX {formatBytes(currentStatus.selectedInterfaceTraffic.rxBytes)} / TX {formatBytes(currentStatus.selectedInterfaceTraffic.txBytes)}</div>}</div><div className="mb-2 rounded border border-border/80 bg-surface p-2"><div className="mb-1 font-medium">进程</div><div className="max-h-20 overflow-auto">{(currentStatus.topProcesses || []).map((proc) => <div key={`${proc.pid}-${proc.command}`} className="grid grid-cols-[40px_45px_45px_1fr] gap-1 border-b border-border/50 py-0.5"><span>{proc.pid}</span><span>{proc.cpuPercent}%</span><span>{proc.memoryPercent}%</span><span className="truncate">{proc.command}</span></div>)}</div></div><div className="rounded border border-border/80 bg-surface p-2"><div className="mb-1 font-medium">磁盘</div><div className="max-h-18 overflow-auto">{(currentStatus.disks || []).map((disk) => <div key={`${disk.filesystem}-${disk.mountPoint}`} className="grid grid-cols-[1fr_90px] gap-2 border-b border-border/50 py-0.5"><span className="truncate">{disk.mountPoint}</span><span className="text-right">{disk.used}/{disk.total}</span></div>)}</div></div></>}</div>}
                          secondary={<div className="h-full rounded-xl border border-border/90 bg-panel p-2"><div className="mb-2 flex items-center justify-between"><div className="text-sm font-semibold">AI 助手</div>{aiAnswer?.suggestedCommand && <button type="button" className="rounded bg-accent px-2 py-1 text-xs text-white" onClick={() => setCommandInput(aiAnswer.suggestedCommand)}>写入终端</button>}</div><form className="space-y-2" onSubmit={askAi}><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={aiIncludeOutput} onChange={(event) => setAiIncludeOutput(event.target.checked)} />读取终端结果</label><textarea className="h-20 w-full rounded border border-border bg-surface px-2 py-1.5 text-sm" value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} placeholder="输入问题" /><button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">提问</button></form><div className="mt-2 h-[calc(100%-8rem)] overflow-auto rounded border border-border/80 bg-surface p-2 text-xs whitespace-pre-wrap">{aiAnswer?.answer || "AI 回答会显示在这里"}</div></div>}
                        />
                      }
                    />
                  </section>
                }
              />
            }
          />
        </div>

        <footer className="panel-card flex items-center justify-between px-4 py-2 text-xs">
          <div className="text-muted">{busy ? `进行中: ${busy}` : "就绪"}</div>
          <div className="max-w-[60%] truncate text-right text-danger">{error}</div>
        </footer>
      </div>
    </div>
  );
}

function splitPath(path) {
  const normalized = path && path.trim() ? path : "/";
  const chunks = normalized.split("/").filter(Boolean);
  const rows = [{ label: "/", path: "/" }];
  let current = "";
  for (const chunk of chunks) {
    current += `/${chunk}`;
    rows.push({ label: chunk, path: current || "/" });
  }
  return rows;
}

function joinPath(base, fileName) {
  if (!base || base === "/") {
    return `/${fileName}`;
  }
  return `${base.replace(/\/+$/, "")}/${fileName}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64Value) {
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const display = value / 1024 ** index;
  return `${display.toFixed(display >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export default App;
