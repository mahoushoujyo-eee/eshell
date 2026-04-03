import { MessageSquareMore, Plus, Trash2 } from "lucide-react";
import { getOpsAgentPreviewText } from "../../../lib/ops-agent-message-rendering";

export default function AiConversationHistory({
  historyVisible,
  historyPanelWidth,
  isDrawer,
  hasManagedShell,
  conversations,
  activeConversationId,
  onCreateConversation,
  onSelectConversation,
  onRequestDeleteConversation,
}) {
  return (
    <div
      className={[
        "min-h-0 shrink-0 overflow-hidden transition-[width,opacity,border-color] duration-200 ease-out",
        historyVisible ? "opacity-100" : "opacity-0",
        historyVisible ? "border-r border-border/70" : "border-r border-transparent",
      ].join(" ")}
      style={{ width: historyVisible ? `${historyPanelWidth}px` : "0px" }}
      aria-hidden={!historyVisible}
    >
      <aside
        className={["flex h-full flex-col", isDrawer ? "bg-surface/42" : "bg-surface/28"].join(" ")}
        style={{ width: `${historyPanelWidth}px` }}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            <MessageSquareMore className="h-3.5 w-3.5" aria-hidden="true" />
            Chats
          </span>
          {!hasManagedShell ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-xl border border-border bg-surface px-2 py-1 text-[11px] hover:bg-accent-soft"
              onClick={onCreateConversation}
              title="New conversation"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-auto px-2 py-2">
          {conversations.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/80 px-3 py-2 text-[11px] text-muted">
              No conversations yet
            </div>
          ) : (
            conversations.map((item) => {
              const selected = item.id === activeConversationId;
              return (
                <div
                  key={item.id}
                  className={[
                    "group flex items-start gap-1 rounded-2xl border p-2 transition-colors",
                    selected
                      ? "border-accent/45 bg-accent-soft/80"
                      : "border-border/75 bg-surface/60 hover:bg-surface/85",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectConversation(item.id)}
                  >
                    <div className="truncate text-xs font-medium">{item.title}</div>
                    <div className="mt-0.5 truncate text-[10px] text-muted">
                      {getOpsAgentPreviewText(item.lastMessagePreview) || "No messages"}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-border/70 p-1 text-muted opacity-0 transition-opacity hover:border-danger/40 hover:text-danger group-hover:opacity-100"
                    onClick={() => onRequestDeleteConversation(item)}
                    title="Delete conversation"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
