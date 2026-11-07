import { useEffect, useRef, useState } from "react";
import {
  CircleStop,
  FolderKanban,
  MoreHorizontal,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import AcpAgentLogo from "../../ai/AcpAgentLogo";
import AcpAgentMenu from "./AcpAgentMenu";
import { useI18n } from "../../../lib/i18n";
import { cx } from "../../ui/cx";

/**
 * Conversation tabs for the ACP dock.
 *
 * One tab is one conversation. Each agent process can host several, so opening
 * a tab never stops anything: the previous conversation keeps streaming in the
 * background, and this strip is what tells the user it is still alive.
 */

const tabTitle = (conversation) => {
  if (conversation.title) {
    return conversation.title;
  }
  const firstUser = conversation.transcript.find((entry) => entry.type === "user");
  const text = String(firstUser?.text || "").replaceAll("\n", " ").trim();
  // No message yet: the tab is still a blank conversation. Its agent is already
  // carried by the brand mark, so naming the agent here would just make two
  // fresh tabs of the same agent look identical.
  return text.slice(0, 34) || null;
};

const pendingPermissions = (conversation) =>
  conversation.transcript.filter(
    (entry) => entry.type === "permission" && entry.resolution == null,
  ).length;

function TabBadge({ conversation, t }) {
  const pending = pendingPermissions(conversation);
  if (pending > 0) {
    return (
      <span
        title={t("Waiting for approval")}
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning/20 px-1 text-[9px] font-semibold tabular-nums text-warning"
      >
        {pending > 9 ? "9+" : pending}
      </span>
    );
  }
  if (conversation.turnActive) {
    return (
      <span
        title={t("Agent working…")}
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
        aria-label={t("Agent working…")}
      />
    );
  }
  if (conversation.ended) {
    return (
      <span
        title={t("Session ended")}
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted/50"
        aria-label={t("Session ended")}
      />
    );
  }
  if (conversation.unread > 0) {
    return (
      <span
        title={t("New reply")}
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        aria-label={t("New reply")}
      />
    );
  }
  return null;
}

export default function AcpSessionTabs({
  conversations,
  activeKey,
  agents,
  historyOpen,
  onSelect,
  onClose,
  onNewConversation,
  onOpenHistory,
  onStopAgent,
}) {
  const { t } = useI18n();
  const stripRef = useRef(null);
  const menuRef = useRef(null);
  // null | "new" | "more"
  const [menu, setMenu] = useState(null);

  const activeConversation = conversations.find((row) => row.key === activeKey) || null;

  useEffect(() => {
    if (!activeKey) {
      return;
    }
    const strip = stripRef.current;
    const tab = strip?.querySelector?.(`[data-conversation-tab="${activeKey}"]`);
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, conversations.length]);

  // Dismiss the popovers on outside click or Escape, and keep Escape from
  // reaching App's "close the whole dock" handler while one is open.
  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) {
        return;
      }
      setMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menu]);

  // A mouse wheel only scrolls vertically; map it onto the horizontal strip.
  const handleWheel = (event) => {
    const strip = stripRef.current;
    if (!strip || event.deltaX !== 0 || event.deltaY === 0) {
      return;
    }
    strip.scrollLeft += event.deltaY;
  };

  const pickAgent = (agentId) => {
    setMenu(null);
    onNewConversation(agentId);
  };

  return (
    <div
      ref={menuRef}
      data-tauri-no-drag
      className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5"
    >
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t("Conversations")}
        className="tab-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        onWheel={handleWheel}
      >
        {conversations.map((conversation) => {
          const active = conversation.key === activeKey;
          const agent = agents.find((row) => row.id === conversation.agentId) || null;
          const title = tabTitle(conversation) || t("New conversation");
          return (
            <div
              key={conversation.key}
              data-conversation-tab={conversation.key}
              className={cx(
                "group flex h-7 max-w-[12rem] shrink-0 items-center rounded-md border text-xs transition-colors duration-150",
                active
                  ? "border-border bg-panel text-text shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                  : "border-transparent text-muted hover:bg-hover hover:text-text",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(conversation.key)}
                title={`${conversation.agentName} · ${conversation.cwd || t("Default working directory")}`}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-0.5 pl-2"
              >
                <AcpAgentLogo agent={agent} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{title}</span>
                <TabBadge conversation={conversation} t={t} />
              </button>
              <button
                type="button"
                onClick={() => onClose(conversation.key)}
                aria-label={t("Close conversation {name}", { name: title })}
                title={t("Close conversation {name}", { name: title })}
                className={cx(
                  "mr-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:bg-hover hover:text-text",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setMenu((prev) => (prev === "new" ? null : "new"))}
        aria-haspopup="menu"
        aria-expanded={menu === "new"}
        aria-label={t("New conversation")}
        title={t("New conversation")}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* Projects and their conversations. This used to be a chevron, which
          read as "expand something" rather than "open the project list" — the
          same folder mark the panel used for Projects before the redesign
          says what it is. */}
      <button
        type="button"
        onClick={onOpenHistory}
        aria-pressed={historyOpen}
        aria-label={t("Conversations")}
        title={t("Conversations")}
        className={cx(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
          historyOpen ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-text",
        )}
      >
        <FolderKanban className="h-4 w-4" aria-hidden="true" />
      </button>

      {activeConversation?.agentId ? (
        <button
          type="button"
          onClick={() => setMenu((prev) => (prev === "more" ? null : "more"))}
          aria-haspopup="menu"
          aria-expanded={menu === "more"}
          aria-label={t("Conversation options")}
          title={t("Conversation options")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}

      {menu === "new" ? (
        <div className="absolute top-full right-1.5 left-1.5 z-30 mt-1 overflow-hidden rounded-lg border border-border bg-elevated shadow-overlay">
          <div className="px-3 pt-2 pb-1 text-[10.5px] font-medium tracking-[0.08em] text-subtle uppercase">
            {t("Start a conversation with")}
          </div>
          <AcpAgentMenu agents={agents} onPick={pickAgent} />
        </div>
      ) : null}

      {menu === "more" && activeConversation ? (
        <div className="absolute top-full right-1.5 z-30 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-overlay">
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              onStopAgent(activeConversation.agentId);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger/10"
          >
            <CircleStop className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t("Stop agent process")}</span>
          </button>
          <p className="flex items-start gap-1.5 px-2 py-1.5 text-[10px] leading-relaxed text-muted">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            {t("Ends every conversation of this agent.")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
