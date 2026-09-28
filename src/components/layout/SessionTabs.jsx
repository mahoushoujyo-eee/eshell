import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../lib/i18n";
import { sessionTabLabels } from "../../utils/sessionTabLabels";
import { IconButton } from "../ui/Button";
import { cx } from "../ui/cx";

/**
 * Session tabs in the title bar. The strip sizes to its tabs and scrolls
 * sideways when they overflow, so the title bar's free space to its right
 * stays a window drag area.
 */
export default function SessionTabs({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  disconnectedSessions = {},
  onNewSession,
}) {
  const { t } = useI18n();
  const stripRef = useRef(null);
  const labels = useMemo(() => sessionTabLabels(sessions), [sessions]);
  const list = Array.isArray(sessions) ? sessions : [];

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeSessionId) {
      return;
    }
    const activeTab = strip.querySelector?.(`[data-session-tab="${activeSessionId}"]`);
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSessionId]);

  // A mouse wheel only scrolls vertically; map it onto the horizontal strip.
  const handleWheel = (event) => {
    const strip = stripRef.current;
    if (!strip || event.deltaX !== 0 || event.deltaY === 0) {
      return;
    }
    strip.scrollLeft += event.deltaY;
  };

  return (
    <div data-window-control className="flex min-w-0 flex-initial items-center gap-1">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t("Sessions")}
        className="tab-strip flex min-w-0 items-center gap-1 overflow-x-auto"
        onWheel={handleWheel}
      >
        {list.map((session) => {
          const active = session.id === activeSessionId;
          const disconnected = Boolean(disconnectedSessions[session.id]);
          const label = labels.get(session.id) || session.configName;
          return (
            <div
              key={session.id}
              data-session-tab={session.id}
              className={cx(
                "group flex h-7 max-w-[220px] shrink-0 items-center rounded-md border text-xs transition-colors duration-150",
                active
                  ? "border-border bg-panel text-text shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                  : "border-transparent text-muted hover:bg-hover hover:text-text",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="flex h-full min-w-0 items-center gap-2 pr-1 pl-2.5"
                onClick={() => onSelectSession(session.id)}
                title={session.currentDir || label}
              >
                <span
                  className={cx(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    disconnected ? "bg-danger" : active ? "bg-success" : "bg-success/60",
                  )}
                  title={disconnected ? t("Session disconnected") : undefined}
                  aria-label={disconnected ? t("Session disconnected") : undefined}
                />
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                className={cx(
                  "mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:bg-hover hover:text-text",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
                onClick={() => onCloseSession(session.id)}
                aria-label={t("Close session {name}", { name: label })}
                title={t("Close session {name}", { name: label })}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {list.length === 0 ? (
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-text"
          onClick={onNewSession}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("New connection")}
        </button>
      ) : (
        <IconButton label={t("New connection")} size="sm" onClick={onNewSession}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
