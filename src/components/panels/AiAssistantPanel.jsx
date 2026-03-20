import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquareMore,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { normalizeShellContextAttachment } from "../../lib/ops-agent-shell-context";

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
      className="my-2 overflow-auto rounded-xl border border-border/80 bg-panel/95 p-2 font-mono text-[11px]"
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

const actionButtonClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border/75 bg-surface/75 text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text";

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

const toolLabel = (toolKind) => {
  if (typeof toolKind !== "string" || !toolKind.trim()) {
    return "tool";
  }
  return toolKind.trim();
};

function HeaderActionButton({ title, onClick, children, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      className={actionButtonClass}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function ShellContextChip({
  shellContext,
  expanded = false,
  onToggle,
  removable = false,
  onRemove,
  inverted = false,
}) {
  const interactive = typeof onToggle === "function";
  const frameClass = inverted
    ? "border-white/18 bg-white/10 text-white hover:border-white/28 hover:bg-white/14"
    : "border-border/75 bg-surface/78 text-text hover:border-accent/35 hover:bg-accent-soft/55";
  const iconClass = inverted
    ? "bg-white/14 text-white"
    : "bg-accent-soft text-accent";
  const buttonClass = interactive
    ? "transition-colors"
    : "";

  const body = (
    <>
      <span
        className={[
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          iconClass,
        ].join(" ")}
      >
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div
          className={[
            "truncate text-[10px] font-semibold uppercase tracking-[0.16em]",
            inverted ? "text-white/70" : "text-muted",
          ].join(" ")}
        >
          Shell Context / {shellContext.sessionName}
        </div>
        {!interactive ? (
          <div className={["truncate font-mono text-[11px]", inverted ? "text-white" : "text-text"].join(" ")}>
            {shellContext.preview}
          </div>
        ) : null}
      </div>
      <span
        className={[
          "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
          inverted ? "bg-white/12 text-white/80" : "bg-warm text-muted",
        ].join(" ")}
      >
        {shellContext.charCount}
      </span>
      {interactive ? (
        expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )
      ) : null}
      {removable ? (
        <button
          type="button"
          className={[
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
            inverted ? "hover:bg-white/10" : "hover:bg-black/5",
          ].join(" ")}
          onClick={onRemove}
          title="Remove selected shell context"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={[
          "inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-left text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
          frameClass,
          buttonClass,
        ].join(" ")}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      className={[
        "inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
        frameClass,
      ].join(" ")}
    >
      {body}
    </div>
  );
}

function ToolMessageChip({ toolKind, expanded = false, onToggle }) {
  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border border-[#efc77a] bg-[#fff3d8] px-2.5 py-1.5 text-left text-[11px] text-[#5f3e00] shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] transition-colors hover:border-[#e1b95d] hover:bg-[#ffecc3]"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? "Hide tool details" : "Show tool details"}
    >
      <span className="rounded-full bg-[#f5d48e] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#714800]">
        {toolLabel(toolKind)}
      </span>
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

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
  shellContext,
  onClearShellContext,
  isStreaming,
  streamingText,
  onAskAi,
  onOpenAiConfig,
  onClose,
  variant = "panel",
}) {
  const isDrawer = variant === "drawer";
  const isDock = variant === "dock";
  const hasManagedShell = isDrawer || isDock;
  const historyPanelWidth = hasManagedShell ? 184 : 208;
  const messages = activeConversation?.messages || [];
  const hasContent = messages.length > 0 || (isStreaming && streamingText);
  const messageScrollRef = useRef(null);
  const [historyVisible, setHistoryVisible] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.localStorage.getItem("eshell:ai-history-visible") !== "0";
  });
  const [expandedShellMessageIds, setExpandedShellMessageIds] = useState(() => ({}));
  const [expandedToolMessageIds, setExpandedToolMessageIds] = useState(() => ({}));

  useEffect(() => {
    const node = messageScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [messages, isStreaming, streamingText, activeConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:ai-history-visible", historyVisible ? "1" : "0");
  }, [historyVisible]);

  useEffect(() => {
    setExpandedShellMessageIds({});
    setExpandedToolMessageIds({});
  }, [activeConversationId]);

  const handleInputKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    onAskAi(event);
  };

  const toggleShellContextMessage = (messageId) => {
    setExpandedShellMessageIds((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  };

  const toggleToolMessage = (messageId) => {
    setExpandedToolMessageIds((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  };

  return (
    <div
      className={[
        "flex h-full min-h-0 flex-col overflow-hidden",
        isDrawer
          ? "rounded-[28px] border border-border/70 bg-surface/88 shadow-[0_28px_90px_rgba(6,10,14,0.34)] backdrop-blur-2xl ring-1 ring-white/6"
          : "bg-panel",
      ].join(" ")}
    >
      {hasManagedShell && (
        <header
          className={[
            "flex items-center gap-3 border-b border-border/70",
            isDrawer ? "px-4 py-3" : "bg-panel px-3 py-3",
          ].join(" ")}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span
              className={[
                "inline-flex h-10 w-10 items-center justify-center rounded-2xl text-accent",
                isDrawer
                  ? "border border-accent/35 bg-accent-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]"
                  : "border border-border/70 bg-surface/70",
              ].join(" ")}
            >
              <Bot className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Ops Agent</div>
              <div className="truncate text-[11px] uppercase tracking-[0.18em] text-muted">
                Live diagnostics and guided actions
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {hasManagedShell ? (
              <HeaderActionButton
                title={historyVisible ? "Hide chat history" : "Show chat history"}
                onClick={() => setHistoryVisible((current) => !current)}
              >
                {historyVisible ? (
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                )}
              </HeaderActionButton>
            ) : null}
            <HeaderActionButton title="New conversation" onClick={onCreateConversation}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </HeaderActionButton>
            {onOpenAiConfig ? (
              <HeaderActionButton title="AI config" onClick={onOpenAiConfig}>
                <Settings2 className="h-4 w-4" aria-hidden="true" />
              </HeaderActionButton>
            ) : null}
            {onClose ? (
              <HeaderActionButton title="Close AI chat" onClick={onClose}>
                <X className="h-4 w-4" aria-hidden="true" />
              </HeaderActionButton>
            ) : null}
          </div>
        </header>
      )}

      <div className="flex min-h-0 flex-1">
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
            className={[
              "flex h-full flex-col",
              isDrawer ? "bg-surface/42" : "bg-surface/28",
            ].join(" ")}
            style={{ width: `${historyPanelWidth}px` }}
          >
            <div className="flex items-center justify-between border-b border-border/70 px-3 py-3">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                <MessageSquareMore className="h-3.5 w-3.5" aria-hidden="true" />
                Chats
              </span>
              {!hasManagedShell && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-xl border border-border bg-surface px-2 py-1 text-[11px] hover:bg-accent-soft"
                  onClick={onCreateConversation}
                  title="New conversation"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New
                </button>
              )}
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
                          {item.lastMessagePreview || "No messages"}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="rounded-xl border border-border/70 p-1 text-muted opacity-0 transition-opacity hover:border-danger/40 hover:text-danger group-hover:opacity-100"
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
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-3">
            {!hasManagedShell && (
              <div className="inline-flex items-center gap-2 text-sm font-semibold">
                <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
                Ops Agent
              </div>
            )}
            {hasManagedShell && (
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Model</span>
            )}
            <select
              className={[
                "min-w-0 border border-border/75 bg-surface/75 px-3 py-2 text-xs outline-none",
                hasManagedShell ? "ml-auto max-w-[72%] rounded-xl" : "ml-auto max-w-[60%]",
              ].join(" ")}
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
            <div className="shrink-0 border-b border-border/70 bg-[#fff7e8] px-3 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-[#8a5a00]">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                Pending write_shell confirmation
              </div>
              <div className="max-h-32 space-y-2 overflow-auto">
                {pendingActions.map((action) => {
                  const busy = resolvingActionId === action.id;
                  return (
                    <div
                      key={action.id}
                      className="rounded-2xl border border-[#efc77a] bg-[#fff3d8] p-2 text-[11px]"
                    >
                      <div className="mb-1 truncate font-mono text-[11px] text-[#5f3e00]">
                        {action.command}
                      </div>
                      <div className="mb-2 truncate text-[#8a5a00]">{action.reason || "no reason"}</div>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-xl border border-success/50 bg-success/85 px-2.5 py-1.5 text-white disabled:opacity-40"
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
                          className="inline-flex items-center gap-1 rounded-xl border border-danger/50 bg-danger/85 px-2.5 py-1.5 text-white disabled:opacity-40"
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

          <div
            ref={messageScrollRef}
            className={[
              "min-h-0 flex-1 overflow-auto px-3 py-3",
              isDrawer ? "bg-transparent" : "bg-surface/12",
            ].join(" ")}
          >
            {!hasContent ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-xs text-muted">
                <span className="max-w-[18rem] leading-6">
                  Start a conversation about ops troubleshooting, diagnostics, or safe command planning.
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  const isTool = message.role === "tool";
                  const isAssistant = message.role === "assistant";
                  const shellContext = normalizeShellContextAttachment(message.shellContext);
                  const shellContextExpanded = Boolean(expandedShellMessageIds[message.id]);
                  const toolMessageExpanded = Boolean(expandedToolMessageIds[message.id]);

                  return (
                    <div key={message.id} className={["flex", isUser ? "justify-end" : "justify-start"].join(" ")}>
                      <article
                        className={[
                          "max-w-[92%] border px-4 py-3 text-xs",
                          isDrawer ? "rounded-3xl shadow-[0_12px_30px_rgba(12,18,24,0.08)]" : "rounded-2xl shadow-none",
                          isUser
                            ? "border-accent bg-accent text-white"
                            : isTool
                              ? "border-[#efc77a] bg-[#fff8e8] text-[#5f3e00]"
                              : "border-border/80 bg-panel/95 text-text",
                        ].join(" ")}
                      >
                        <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] opacity-80">
                          <span>{roleLabel(message.role)}</span>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        {shellContext ? (
                          <div className="mb-2">
                            <ShellContextChip
                              shellContext={shellContext}
                              expanded={shellContextExpanded}
                              onToggle={() => toggleShellContextMessage(message.id)}
                              inverted={isUser}
                            />
                          </div>
                        ) : null}
                        {shellContext && shellContextExpanded ? (
                          <div
                            className={[
                              "mb-2 rounded-2xl border px-3 py-2",
                              isUser
                                ? "border-white/18 bg-black/12 text-white/92"
                                : "border-border/75 bg-surface/72 text-text",
                            ].join(" ")}
                          >
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                              {shellContext.content}
                            </pre>
                          </div>
                        ) : null}
                        {isTool ? (
                          <>
                            <div className="mb-1">
                              <ToolMessageChip
                                toolKind={message.toolKind}
                                expanded={toolMessageExpanded}
                                onToggle={() => toggleToolMessage(message.id)}
                              />
                            </div>
                            {toolMessageExpanded ? (
                              <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
                                {message.content}
                              </pre>
                            ) : null}
                          </>
                        ) : isAssistant ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                            {message.content}
                          </ReactMarkdown>
                        ) : (
                          <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
                            {message.content}
                          </pre>
                        )}
                      </article>
                    </div>
                  );
                })}

                {isStreaming && (
                  <div className="flex justify-start">
                    <article
                      className={[
                        "max-w-[92%] border border-border/80 bg-panel/95 px-4 py-3 text-xs",
                        isDrawer ? "rounded-3xl shadow-[0_12px_30px_rgba(12,18,24,0.08)]" : "rounded-2xl shadow-none",
                      ].join(" ")}
                    >
                      <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted">
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

          <form
            className={[
              "shrink-0 border-t border-border/70 px-3 py-3",
              isDrawer ? "bg-surface/42" : "bg-panel",
            ].join(" ")}
            onSubmit={onAskAi}
          >
            {shellContext ? (
              <div className="mb-2 flex items-center">
                <ShellContextChip
                  shellContext={shellContext}
                  removable
                  onRemove={onClearShellContext}
                />
              </div>
            ) : null}
            <textarea
              className={[
                "w-full border border-border/75 bg-surface/75 px-3 py-2 text-sm outline-none",
                hasManagedShell ? "h-28 rounded-2xl" : "h-20",
              ].join(" ")}
              value={aiQuestion}
              onChange={(event) => setAiQuestion(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Ask the ops agent about diagnostics, root cause, or safe commands..."
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-muted">
                {activeConversationId
                  ? `Conversation: ${activeConversation?.title || activeConversationId}`
                  : "No active conversation"}
                {hasManagedShell && onClose ? " / Esc to close" : ""}
              </span>
              <button
                type="submit"
                disabled={!aiQuestion.trim() || isStreaming}
                className={[
                  "inline-flex items-center gap-1.5 border border-accent bg-accent px-4 py-2 text-xs font-medium text-white disabled:opacity-45",
                  isDrawer ? "rounded-2xl shadow-[0_12px_28px_rgba(28,122,103,0.28)]" : "rounded-xl shadow-none",
                ].join(" ")}
              >
                {isStreaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {isStreaming ? "Streaming" : "Send"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
