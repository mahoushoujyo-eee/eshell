import { useMemo } from "react";
import { useI18n } from "../../lib/i18n";
import { sessionTabLabels } from "../../utils/sessionTabLabels";
import XtermConsole from "./XtermConsole";

/**
 * The terminal area. Session tabs live in the title bar and the working
 * directory in the status bar, so this panel is the terminal alone.
 */
export default function TerminalPanel({
  sessions,
  onReconnectSession,
  disconnectedSessions = {},
  activeSession,
  onPtyInput,
  onPtyResize,
  onAttachSelectionToAi,
  wallpaper,
  onNewSession,
}) {
  const { t } = useI18n();
  const activeDisconnectReason = activeSession
    ? disconnectedSessions[activeSession.id] || ""
    : "";

  const sessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
  const tabLabels = useMemo(() => sessionTabLabels(sessions), [sessions]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
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
        onNewSession={onNewSession}
      />
    </section>
  );
}
