import { useMemo } from "react";
import { FolderOpen, Terminal, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import XtermConsole from "./XtermConsole";

export default function TerminalPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onReconnectSession,
  disconnectedSessions = {},
  activeSession,
  onPtyInput,
  onPtyResize,
  onAttachSelectionToAi,
  wallpaper,
}) {
  const { t } = useI18n();
  const activeDisconnectReason = activeSession
    ? disconnectedSessions[activeSession.id] || ""
    : "";

  const sessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);

  // Several tabs can point at the same server profile, and the profile name alone
  // makes them indistinguishable. Only the duplicated names get an index.
  const tabLabels = useMemo(() => {
    const totals = new Map();
    sessions.forEach((session) => {
      totals.set(session.configName, (totals.get(session.configName) || 0) + 1);
    });
    const seen = new Map();
    return new Map(
      sessions.map((session) => {
        const ordinal = (seen.get(session.configName) || 0) + 1;
        seen.set(session.configName, ordinal);
        const label =
          totals.get(session.configName) > 1
            ? `${session.configName} #${ordinal}`
            : session.configName;
        return [session.id, label];
      }),
    );
  }, [sessions]);

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
                  title={session.currentDir}
                >
                  <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                  {tabLabels.get(session.id) || session.configName}
                  {disconnectedSessions[session.id] ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
                      title={t("Session disconnected")}
                      aria-label={t("Session disconnected")}
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 text-current/80 transition-colors hover:bg-black/10 hover:text-current"
                  onClick={() => onCloseSession(session.id)}
                  aria-label={t("Close session {name}", {
                    name: tabLabels.get(session.id) || session.configName,
                  })}
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
          sessionIds={sessionIds}
          activeSessionId={activeSession?.id || null}
          activeSessionName={
            activeSession ? tabLabels.get(activeSession.id) || activeSession.configName : t("Shell")
          }
          disconnected={Boolean(activeSession && activeDisconnectReason)}
          disconnectReason={activeDisconnectReason}
          onReconnect={
            activeSession && onReconnectSession
              ? () => onReconnectSession(activeSession.id)
              : undefined
          }
          onInput={onPtyInput}
          onResize={onPtyResize}
          onAttachSelection={onAttachSelectionToAi}
          wallpaper={wallpaper}
        />
      </div>
    </section>
  );
}
