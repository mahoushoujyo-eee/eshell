import { FolderOpen, Play, Terminal, X } from "lucide-react";

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
    <section className="h-full border-b border-border bg-panel">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-auto bg-warm p-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={[
                  "group flex shrink-0 items-center gap-1 border border-border/70 px-2 py-1 text-xs",
                  activeSessionId === session.id
                    ? "border-accent bg-accent text-white"
                    : "border-border bg-surface text-text",
                ].join(" ")}
              >
                <button
                  type="button"
                  className="inline-flex items-center gap-1 truncate"
                  onClick={() => onSelectSession(session.id)}
                >
                  <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                  {session.configName}
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 text-current/80 transition-colors hover:bg-black/10 hover:text-current"
                  onClick={() => onCloseSession(session.id)}
                  aria-label={`Close session ${session.configName}`}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="inline-flex items-center gap-2 px-2 py-1 text-xs text-muted">
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                No active sessions
              </div>
            )}
          </div>

          {activeSession && (
            <div className="inline-flex max-w-[45%] items-center gap-1 border border-border/70 bg-accent-soft px-2 py-1 text-xs text-muted">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{activeSession.currentDir}</span>
            </div>
          )}
        </header>

        <form className="flex gap-2 border-b border-border px-2 py-2" onSubmit={onExecCommand}>
          <div className="relative flex-1">
            <Terminal className="pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              className="w-full border border-border bg-surface px-8 py-2 text-sm"
              placeholder={activeSession ? "Run command" : "Connect a session first"}
              value={commandInput}
              disabled={!activeSession}
              onChange={(event) => setCommandInput(event.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={!activeSession}
            className="inline-flex items-center gap-1.5 border border-accent bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            Run
          </button>
        </form>

        <div
          className="terminal-wallpaper min-h-0 flex-1 overflow-auto bg-[#111b19] p-3 font-mono text-xs text-[#d6f6dc]"
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
          {currentLogs.length === 0 && (
            <div className="inline-flex items-center gap-2 text-[#93b9a2]">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              Terminal output appears here
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
