export default function TerminalPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  activeSession,
  commandInput,
  setCommandInput,
  onExecCommand,
  currentLogs,
  wallpaper,
  wallpapers,
}) {
  return (
    <section className="h-full p-3">
      <div className="h-full rounded-xl border border-border/90 bg-panel p-2">
        <header className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-auto rounded-lg bg-warm p-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={[
                  "group flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs",
                  activeSessionId === session.id ? "bg-accent text-white" : "bg-surface text-text",
                ].join(" ")}
              >
                <button type="button" className="truncate" onClick={() => onSelectSession(session.id)}>
                  {session.configName}
                </button>
                <button type="button" className="rounded px-1" onClick={() => onCloseSession(session.id)}>
                  ×
                </button>
              </div>
            ))}
            {sessions.length === 0 && <div className="px-2 py-1 text-xs text-muted">暂无活跃会话</div>}
          </div>
          {activeSession && (
            <div className="rounded bg-accent-soft px-2 py-1 text-xs text-muted">{activeSession.currentDir}</div>
          )}
        </header>

        <form className="mb-2 flex gap-2" onSubmit={onExecCommand}>
          <input
            className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
            placeholder={activeSession ? "输入远程命令" : "请先建立会话"}
            value={commandInput}
            disabled={!activeSession}
            onChange={(event) => setCommandInput(event.target.value)}
          />
          <button
            type="submit"
            disabled={!activeSession}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            执行
          </button>
        </form>

        <div
          className="terminal-wallpaper h-[calc(100%-5.5rem)] overflow-auto rounded-md border border-border bg-[#111b19] p-3 font-mono text-xs text-[#d6f6dc]"
          style={{
            backgroundImage:
              wallpaper === 0
                ? undefined
                : `${wallpapers[wallpaper]}, linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,.6))`,
          }}
        >
          {currentLogs.map((row) => (
            <div key={row.id} className="mb-2">
              <div className="mb-1 text-[10px] text-[#8ca799]">
                [{row.ts}] {row.tag}
              </div>
              <pre className="whitespace-pre-wrap break-words">{row.text}</pre>
            </div>
          ))}
          {currentLogs.length === 0 && <div className="text-[#93b9a2]">终端输出显示区域</div>}
        </div>
      </div>
    </section>
  );
}
