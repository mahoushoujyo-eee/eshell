import { FolderOpen, Terminal, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import XtermConsole from "./XtermConsole";

export default function TerminalPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  activeSession,
  onPtyInput,
  onPtyResize,
  onAttachSelectionToAi,
  wallpaper,
}) {
  const { t } = useI18n();

  return (
    <section className="h-full border-b border-border bg-panel">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-auto bg-warm p-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={[
                  "group flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs",
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
                  aria-label={t("Close session {name}", { name: session.configName })}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="inline-flex items-center gap-2 px-2 py-1 text-xs text-muted">
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                {t("No active sessions")}
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

        <XtermConsole
          activeSessionId={activeSession?.id || null}
          activeSessionName={activeSession?.configName || t("Shell")}
          onInput={onPtyInput}
          onResize={onPtyResize}
          onAttachSelection={onAttachSelectionToAi}
          wallpaper={wallpaper}
        />
      </div>
    </section>
  );
}
