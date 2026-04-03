import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
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
import {
  getOpsAgentAssistantReplyText,
  getOpsAgentLatestAssistantReplyText,
  getOpsAgentPreviewText,
  groupOpsAgentMessages,
  splitOpsAgentMessageContent,
} from "../../lib/ops-agent-message-rendering";
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
const messageActionButtonClass =
  "inline-flex items-center gap-1.5 rounded-xl border border-border/75 bg-surface/70 px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text";

const copyText = async (value) => {
  const text = String(value || "");
  if (!text) {
    return false;
  }

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textArea);
  return copied;
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

const formatTurnTime = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const firstTime = formatTime(messages[0]?.createdAt);
  const lastTime = formatTime(messages[messages.length - 1]?.createdAt);

  if (!firstTime) {
    return lastTime;
  }
  if (!lastTime || lastTime === firstTime) {
    return firstTime;
  }
  return `${firstTime} - ${lastTime}`;
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

const pendingRiskLabel = (riskLevel) => {
  if (typeof riskLevel !== "string" || !riskLevel.trim()) {
    return "unknown";
  }
  return riskLevel.trim().toLowerCase();
};

const pendingRiskBadgeClass = (riskLevel) => {
  if (riskLevel === "high") {
    return "border-danger/45 bg-danger/15 text-danger";
  }
  if (riskLevel === "medium") {
    return "border-[#e1b95d] bg-[#ffecc3] text-[#8a5a00]";
  }
  if (riskLevel === "low") {
    return "border-success/45 bg-success/10 text-success";
  }
  return "border-border/75 bg-surface/70 text-muted";
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

function ThinkMessageChip({ expanded = false, onToggle }) {
  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border border-border/75 bg-surface/72 px-2.5 py-1.5 text-left text-[11px] text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:border-accent/35 hover:bg-accent-soft/50 hover:text-text"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? "Hide thinking details" : "Show thinking details"}
    >
      <span className="rounded-full bg-warm px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        think
      </span>
      <span className="truncate">{expanded ? "Hide model reasoning" : "Show model reasoning"}</span>
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

function DeleteConversationDialog({
  open,
  conversationTitle = "",
  busy = false,
  onCancel,
  onConfirm,
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, open]);

  if (!open) {
    return null;
  }

  const safeTitle = conversationTitle?.trim() || "Untitled conversation";

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-[rgba(26,20,14,0.28)] p-4 backdrop-blur-[2px]"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-md rounded-[26px] border border-border/85 bg-panel/98 p-5 shadow-[0_28px_80px_rgba(34,26,16,0.22)] ring-1 ring-white/45"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-conversation-title"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-danger/20 bg-danger/10 text-danger">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div
              id="delete-conversation-title"
              className="text-[10px] font-semibold uppercase tracking-[0.22em] text-danger/75"
            >
              Confirm Delete
            </div>
            <h3 className="mt-1 text-lg font-semibold text-text">Delete this conversation?</h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              <span className="font-medium text-text">{safeTitle}</span> and all of its messages will
              be removed permanently.
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-border/80 bg-surface px-4 py-2 text-sm text-muted transition-colors hover:bg-warm disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-danger/60 bg-danger px-4 py-2 text-sm font-medium text-white shadow-[0_12px_28px_rgba(194,72,50,0.22)] transition-colors hover:bg-[#b53f2b] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
            {busy ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
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
  conversationError = "",
  onClearConversationError,
  onAskAi,
  onCancelStreaming,
  onOpenAiConfig,
  onClose,
  variant = "panel",
}) {
  const isDrawer = variant === "drawer";
  const isDock = variant === "dock";
  const hasManagedShell = isDrawer || isDock;
  const historyPanelWidth = hasManagedShell ? 184 : 208;
  const conversationErrorText = String(conversationError || "").trim();
  const hasConversationError = Boolean(conversationErrorText);
  const messages = activeConversation?.messages || [];
  const messageGroups = groupOpsAgentMessages(messages);
  const hasContent = messageGroups.length > 0 || (isStreaming && streamingText);
  const messageScrollRef = useRef(null);
  const [historyVisible, setHistoryVisible] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.localStorage.getItem("eshell:ai-history-visible") !== "0";
  });
  const [expandedShellMessageIds, setExpandedShellMessageIds] = useState(() => ({}));
  const [expandedToolMessageIds, setExpandedToolMessageIds] = useState(() => ({}));
  const [expandedThinkKeys, setExpandedThinkKeys] = useState(() => ({}));
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState(null);
  const [deleteConversationBusyId, setDeleteConversationBusyId] = useState("");
  const [copiedMessageKey, setCopiedMessageKey] = useState(null);
  const copyFeedbackTimerRef = useRef(null);

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
    setExpandedThinkKeys({});
    setPendingDeleteConversation(null);
    setDeleteConversationBusyId("");
    setCopiedMessageKey(null);
  }, [activeConversationId]);

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

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

  const toggleThinkSection = (sectionKey) => {
    setExpandedThinkKeys((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }));
  };

  const handleCopyMessage = async (messageKey, content) => {
    try {
      const copied = await copyText(content);
      if (!copied) {
        return;
      }

      setCopiedMessageKey(messageKey);
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedMessageKey((current) => (current === messageKey ? null : current));
        copyFeedbackTimerRef.current = null;
      }, 1800);
    } catch (error) {
      console.error("copy ai message failed", error);
    }
  };

  const requestDeleteConversation = (conversation) => {
    if (!conversation?.id) {
      return;
    }

    setPendingDeleteConversation({
      id: conversation.id,
      title: conversation.title || "",
    });
  };

  const closeDeleteConversationDialog = () => {
    if (deleteConversationBusyId) {
      return;
    }
    setPendingDeleteConversation(null);
  };

  const confirmDeleteConversation = async () => {
    const conversationId = pendingDeleteConversation?.id;
    if (!conversationId) {
      return;
    }

    setDeleteConversationBusyId(conversationId);
    try {
      const deleted = await onDeleteConversation(conversationId);
      if (deleted !== false) {
        setPendingDeleteConversation(null);
      }
    } finally {
      setDeleteConversationBusyId("");
    }
  };

  const renderAssistantMessage = (message, sectionKeyPrefix, withDivider = false) => {
    const sections = splitOpsAgentMessageContent(message.content);
    const hasSections = sections.length > 0;

    return (
      <section
        key={message.id || sectionKeyPrefix}
        className={withDivider ? "mt-3 border-t border-border/60 pt-3" : ""}
      >
        {hasSections ? (
          sections.map((section, sectionIndex) => {
            const thinkKey = `${sectionKeyPrefix}:think:${sectionIndex}`;
            const isThink = section.type === "think";
            const thinkExpanded = Boolean(expandedThinkKeys[thinkKey]);

            return (
              <div key={`${sectionKeyPrefix}:${section.type}:${sectionIndex}`} className={sectionIndex > 0 ? "mt-3" : ""}>
                {isThink ? (
                  <div className="rounded-2xl border border-border/70 bg-surface/58">
                    <div className="px-3 py-2">
                      <ThinkMessageChip
                        expanded={thinkExpanded}
                        onToggle={() => toggleThinkSection(thinkKey)}
                      />
                    </div>
                    {thinkExpanded ? (
                      <div className="border-t border-border/60 px-3 py-3 text-[11px] text-muted">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={MARKDOWN_COMPONENTS}
                        >
                          {section.content}
                        </ReactMarkdown>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                    {section.content}
                  </ReactMarkdown>
                )}
              </div>
            );
          })
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{message.content}</pre>
        )}
      </section>
    );
  };

  const renderToolMessage = (message, withDivider = false) => {
    const toolMessageExpanded = Boolean(expandedToolMessageIds[message.id]);

    return (
      <section key={message.id} className={withDivider ? "mt-3 border-t border-border/60 pt-3" : ""}>
        <div className="flex items-start justify-between gap-2">
          <ToolMessageChip
            toolKind={message.toolKind}
            expanded={toolMessageExpanded}
            onToggle={() => toggleToolMessage(message.id)}
          />
          <span className="pt-1 text-[10px] uppercase tracking-[0.16em] text-[#8a5a00]/80">
            {formatTime(message.createdAt)}
          </span>
        </div>
        {toolMessageExpanded ? (
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-2xl border border-[#efc77a] bg-[#fff8e8] px-3 py-2 font-mono text-[12px] text-[#5f3e00]">
            {message.content}
          </pre>
        ) : null}
      </section>
    );
  };

  const renderAgentTurn = (group) => {
    const turnCopyText = getOpsAgentLatestAssistantReplyText(group.messages);

    return (
      <div key={group.id} className="flex justify-start">
        <article
          className={[
            "max-w-[92%] border border-border/80 bg-panel/95 px-4 py-3 text-xs",
            isDrawer ? "rounded-3xl shadow-[0_12px_30px_rgba(12,18,24,0.08)]" : "rounded-2xl shadow-none",
          ].join(" ")}
        >
          <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted">
            <span>Agent</span>
            <span>{formatTurnTime(group.messages)}</span>
          </div>
          {group.messages.map((message, index) => {
            if (message.role === "tool") {
              return renderToolMessage(message, index > 0);
            }
            if (message.role === "assistant") {
              return renderAssistantMessage(message, `${group.id}:${message.id || index}`, index > 0);
            }

            return (
              <section key={message.id || `${group.id}:plain:${index}`} className={index > 0 ? "mt-3 border-t border-border/60 pt-3" : ""}>
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{message.content}</pre>
              </section>
            );
          })}
          {turnCopyText ? (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                className={[
                  messageActionButtonClass,
                  copiedMessageKey === group.id
                    ? "border-success/45 bg-success/10 text-success hover:border-success/45 hover:bg-success/10 hover:text-success"
                    : "",
                ].join(" ")}
                onClick={() => handleCopyMessage(group.id, turnCopyText)}
                title="Copy latest AI reply"
              >
                {copiedMessageKey === group.id ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copiedMessageKey === group.id ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
        </article>
      </div>
    );
  };

  const streamingSections = splitOpsAgentMessageContent(streamingText);
  const streamingCopyText = getOpsAgentAssistantReplyText(streamingText);
  const deleteDialogBusy =
    Boolean(pendingDeleteConversation?.id) && deleteConversationBusyId === pendingDeleteConversation.id;

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
                          {getOpsAgentPreviewText(item.lastMessagePreview) || "No messages"}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="rounded-xl border border-border/70 p-1 text-muted opacity-0 transition-opacity hover:border-danger/40 hover:text-danger group-hover:opacity-100"
                        onClick={() => requestDeleteConversation(item)}
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
                  const riskLevel = pendingRiskLabel(action.riskLevel);
                  return (
                    <div
                      key={action.id}
                      className="rounded-2xl border border-[#efc77a] bg-[#fff3d8] p-2 text-[11px]"
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#5f3e00]">
                          {action.command}
                        </div>
                        <span
                          className={[
                            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                            pendingRiskBadgeClass(riskLevel),
                          ].join(" ")}
                        >
                          {riskLevel}
                        </span>
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
          {hasConversationError ? (
            <div className="shrink-0 border-b border-danger/25 bg-[#ffe9e4] px-3 py-2 text-[#6e2b20]">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-danger/25 bg-white/55 text-danger">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-danger/75">
                    Chat Execution Error
                  </div>
                  <p className="mt-1 break-words text-xs leading-5">{conversationErrorText}</p>
                </div>
                {typeof onClearConversationError === "function" ? (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-xl border border-danger/30 bg-white/70 px-2 py-1 text-[11px] text-danger transition-colors hover:border-danger/45 hover:bg-white"
                    onClick={onClearConversationError}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

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
                {messageGroups.map((group) => {
                  if (group.kind === "agent_turn") {
                    return renderAgentTurn(group);
                  }

                  const message = group.message;
                  const shellContext = normalizeShellContextAttachment(message.shellContext);
                  const shellContextExpanded = Boolean(expandedShellMessageIds[message.id]);

                  return (
                    <div key={group.id} className="flex justify-end">
                      <article
                        className={[
                          "max-w-[92%] border border-accent bg-accent px-4 py-3 text-xs text-white",
                          isDrawer ? "rounded-3xl shadow-[0_12px_30px_rgba(12,18,24,0.08)]" : "rounded-2xl shadow-none",
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
                              inverted
                            />
                          </div>
                        ) : null}
                        {shellContext && shellContextExpanded ? (
                          <div className="mb-2 rounded-2xl border border-white/18 bg-black/12 px-3 py-2 text-white/92">
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                              {shellContext.content}
                            </pre>
                          </div>
                        ) : null}
                        <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
                          {message.content}
                        </pre>
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
                      {streamingSections.length > 0 ? (
                        streamingSections.map((section, sectionIndex) => {
                          const thinkKey = `__streaming__:think:${sectionIndex}`;
                          const thinkExpanded = Boolean(expandedThinkKeys[thinkKey]);

                          return (
                            <div key={`__streaming__:${section.type}:${sectionIndex}`} className={sectionIndex > 0 ? "mt-3" : ""}>
                              {section.type === "think" ? (
                                <div className="rounded-2xl border border-border/70 bg-surface/58">
                                  <div className="px-3 py-2">
                                    <ThinkMessageChip
                                      expanded={thinkExpanded}
                                      onToggle={() => toggleThinkSection(thinkKey)}
                                    />
                                  </div>
                                  {thinkExpanded ? (
                                    <div className="border-t border-border/60 px-3 py-3 text-[11px] text-muted">
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm, remarkBreaks]}
                                        components={MARKDOWN_COMPONENTS}
                                      >
                                        {section.content}
                                      </ReactMarkdown>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm, remarkBreaks]}
                                  components={MARKDOWN_COMPONENTS}
                                >
                                  {section.content}
                                </ReactMarkdown>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={MARKDOWN_COMPONENTS}
                        >
                          {streamingText || "..."}
                        </ReactMarkdown>
                      )}
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          className={[
                            messageActionButtonClass,
                            copiedMessageKey === "__streaming__"
                              ? "border-success/45 bg-success/10 text-success hover:border-success/45 hover:bg-success/10 hover:text-success"
                              : "",
                          ].join(" ")}
                          onClick={() => handleCopyMessage("__streaming__", streamingCopyText)}
                          disabled={!streamingCopyText}
                          title="Copy streaming reply"
                        >
                          {copiedMessageKey === "__streaming__" ? (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {copiedMessageKey === "__streaming__" ? "Copied" : "Copy"}
                        </button>
                      </div>
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
                type={isStreaming ? "button" : "submit"}
                onClick={isStreaming ? onCancelStreaming : undefined}
                disabled={isStreaming ? false : !aiQuestion.trim()}
                className={[
                  "inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white disabled:opacity-45",
                  isStreaming
                    ? "border border-danger/70 bg-danger/85 hover:bg-danger"
                    : "border border-accent bg-accent",
                  isDrawer ? "rounded-2xl shadow-[0_12px_28px_rgba(28,122,103,0.28)]" : "rounded-xl shadow-none",
                ].join(" ")}
              >
                {isStreaming ? <X className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                {isStreaming ? "Stop" : "Send"}
              </button>
            </div>
          </form>
        </section>
      </div>

      <DeleteConversationDialog
        open={Boolean(pendingDeleteConversation)}
        conversationTitle={pendingDeleteConversation?.title || ""}
        busy={deleteDialogBusy}
        onCancel={closeDeleteConversationDialog}
        onConfirm={confirmDeleteConversation}
      />
    </div>
  );
}
