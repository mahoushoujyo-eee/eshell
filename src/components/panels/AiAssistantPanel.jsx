import {
  Bot,
  Check,
  Loader2,
  MessageSquareMore,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const MARKDOWN_COMPONENTS = {
  h1: (props) => <h1 className="mb-2 text-base font-semibold" {...props} />,
  h2: (props) => <h2 className="mb-2 text-sm font-semibold" {...props} />,
  h3: (props) => <h3 className="mb-1 text-sm font-medium" {...props} />,
  p: (props) => <p className="mb-2 leading-6 last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-2 list-disc pl-4 last:mb-0" {...props} />,
  ol: (props) => <ol className="mb-2 list-decimal pl-4 last:mb-0" {...props} />,
  li: (props) => <li className="mb-1" {...props} />,
  a: (props) => (
    <a
      className="text-accent underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted" {...props} />
  ),
  table: (props) => (
    <div className="my-2 overflow-auto">
      <table className="w-full border-collapse text-left text-xs" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-border/70 bg-panel px-2 py-1 font-medium" {...props} />
  ),
  td: (props) => <td className="border border-border/70 px-2 py-1 align-top" {...props} />,
  pre: (props) => (
    <pre
      className="my-2 overflow-auto rounded-md border border-border/80 bg-panel p-2 font-mono text-[11px]"
      {...props}
    />
  ),
  code: ({ inline, className, children, ...props }) =>
    inline ? (
      <code className="rounded bg-warm px-1 py-0.5 font-mono text-[11px]" {...props}>
        {children}
      </code>
    ) : (
      <code className={["font-mono text-[11px]", className].filter(Boolean).join(" ")} {...props}>
        {children}
      </code>
    ),
};

const formatTime = (value) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const roleLabel = (role) => {
  if (role === "user") {
    return "You";
  }
  if (role === "tool") {
    return "Tool";
  }
  return "Agent";
};

export default function AiAssistantPanel({
  aiProfiles,
  activeAiProfileId,
  onSelectAiProfile,
  conversations,
  activeConversationId,
  activeConversation,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
  pendingActions,
  onResolvePendingAction,
  resolvingActionId,
  aiQuestion,
  setAiQuestion,
  isStreaming,
  streamingText,
  onAskAi,
}) {
  const messages = activeConversation?.messages || [];
  const hasContent = messages.length > 0 || (isStreaming && streamingText);
  const messageScrollRef = useRef(null);

  useEffect(() => {
    const node = messageScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [messages, isStreaming, streamingText, activeConversationId]);

  const handleInputKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    onAskAi(event);
  };

  return (
    <div className="flex h-full min-h-0 bg-panel">
      <aside className="flex w-52 min-w-[170px] shrink-0 flex-col border-r border-border bg-surface/35">
        <div className="flex items-center justify-between border-b border-border px-2 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-muted">
            <MessageSquareMore className="h-3.5 w-3.5" aria-hidden="true" />
            Chats
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-border bg-surface px-1.5 py-1 text-[11px] hover:bg-accent-soft"
            onClick={onCreateConversation}
            title="New conversation"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
          {conversations.length === 0 ? (
            <div className="rounded border border-dashed border-border p-2 text-[11px] text-muted">
              No conversations yet
            </div>
          ) : (
            conversations.map((item) => {
              const selected = item.id === activeConversationId;
              return (
                <div
                  key={item.id}
                  className={[
                    "group flex items-start gap-1 border p-1.5",
                    selected
                      ? "border-accent bg-accent-soft"
                      : "border-border bg-surface hover:bg-surface/70",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelectConversation(item.id)}
                  >
                    <div className="truncate text-xs font-medium">{item.title}</div>
                    <div className="truncate text-[10px] text-muted">
                      {item.lastMessagePreview || "No messages"}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border/70 p-1 text-muted opacity-0 transition-opacity hover:border-danger/40 hover:text-danger group-hover:opacity-100"
                    onClick={() => {
                      if (window.confirm("Delete this conversation?")) {
                        onDeleteConversation(item.id);
                      }
                    }}
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

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-2">
          <div className="inline-flex items-center gap-2 text-sm font-semibold">
            <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
            Ops Agent
          </div>
          <select
            className="ml-auto min-w-0 max-w-[60%] border border-border bg-surface px-2 py-1 text-xs"
            value={activeAiProfileId || ""}
            onChange={(event) => onSelectAiProfile(event.target.value)}
            disabled={aiProfiles.length === 0}
          >
            {aiProfiles.length === 0 ? (
              <option value="">No AI profile</option>
            ) : (
              aiProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} / {profile.model}
                </option>
              ))
            )}
          </select>
        </div>

        {pendingActions.length > 0 && (
          <div className="shrink-0 border-b border-border bg-[#fff7e8] px-2 py-2">
            <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-[#8a5a00]">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              Pending write_shell confirmation
            </div>
            <div className="max-h-28 space-y-1 overflow-auto">
              {pendingActions.map((action) => {
                const busy = resolvingActionId === action.id;
                return (
                  <div key={action.id} className="border border-[#efc77a] bg-[#fff3d8] p-2 text-[11px]">
                    <div className="mb-1 truncate font-mono text-[11px] text-[#5f3e00]">
                      {action.command}
                    </div>
                    <div className="mb-2 truncate text-[#8a5a00]">{action.reason || "no reason"}</div>
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        className="inline-flex items-center gap-1 border border-success/50 bg-success/85 px-2 py-1 text-white disabled:opacity-40"
                        onClick={() => onResolvePendingAction(action.id, true)}
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="inline-flex items-center gap-1 border border-danger/50 bg-danger/85 px-2 py-1 text-white disabled:opacity-40"
                        onClick={() => onResolvePendingAction(action.id, false)}
                      >
                        <X className="h-3.5 w-3.5" />
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div ref={messageScrollRef} className="min-h-0 flex-1 overflow-auto bg-surface/20 px-3 py-2">
          {!hasContent ? (
            <div className="flex h-full items-center justify-center text-xs text-muted">
              Start a conversation about ops troubleshooting, diagnostics, or command planning
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((message) => {
                const isUser = message.role === "user";
                const isTool = message.role === "tool";
                const isAssistant = message.role === "assistant";

                return (
                  <div key={message.id} className={["flex", isUser ? "justify-end" : "justify-start"].join(" ")}>
                    <article
                      className={[
                        "max-w-[90%] border px-3 py-2 text-xs",
                        isUser
                          ? "border-accent bg-accent text-white"
                          : isTool
                            ? "border-[#efc77a] bg-[#fff8e8] text-[#5f3e00]"
                            : "border-border bg-panel text-text",
                      ].join(" ")}
                    >
                      <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] opacity-80">
                        <span>{roleLabel(message.role)}</span>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      {isAssistant ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                          {message.content}
                        </ReactMarkdown>
                      ) : (
                        <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{message.content}</pre>
                      )}
                    </article>
                  </div>
                );
              })}

              {isStreaming && (
                <div className="flex justify-start">
                  <article className="max-w-[90%] border border-border bg-panel px-3 py-2 text-xs">
                    <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-muted">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Agent typing
                    </div>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                      {streamingText || "..."}
                    </ReactMarkdown>
                  </article>
                </div>
              )}
            </div>
          )}
        </div>

        <form className="shrink-0 border-t border-border bg-panel px-2 py-2" onSubmit={onAskAi}>
          <textarea
            className="h-20 w-full border border-border bg-surface px-2 py-1.5 text-sm"
            value={aiQuestion}
            onChange={(event) => setAiQuestion(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Ask the ops agent (diagnostics, root cause, safe commands...)"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-muted">
              {activeConversationId
                ? `Conversation: ${activeConversation?.title || activeConversationId}`
                : "No active conversation"}
            </span>
            <button
              type="submit"
              disabled={!aiQuestion.trim() || isStreaming}
              className="inline-flex items-center gap-1.5 border border-accent bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-45"
            >
              {isStreaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {isStreaming ? "Streaming" : "Send"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
