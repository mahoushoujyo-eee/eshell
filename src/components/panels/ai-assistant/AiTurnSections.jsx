import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Loader2,
  TerminalSquare,
  X,
} from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { useI18n } from "../../../lib/i18n";
import { splitOpsAgentMessageContent } from "../../../lib/ops-agent-message-rendering";
import {
  MARKDOWN_COMPONENTS,
  copyText,
  formatTime,
  pendingRiskBadgeClass,
  pendingRiskLabel,
  toolStateBadgeClass,
  toolStateLabel,
  toolLabel,
} from "./aiAssistantUtils";
import { ThinkMessageChip, ToolMessageChip } from "./AiAssistantControls";

export function AssistantMessageSection({
  message,
  sectionKeyPrefix,
  withDivider = false,
  expandedThinkKeys,
  onToggleThinkSection,
}) {
  const sections = splitOpsAgentMessageContent(message.content);
  if (sections.length === 0) {
    return null;
  }

  return (
    <section
      key={message.id || sectionKeyPrefix}
      className={[
        "min-w-0 break-words [overflow-wrap:anywhere]",
        withDivider ? "mt-3 border-t border-border/60 pt-3" : "",
      ].join(" ")}
    >
      {sections.map((section, sectionIndex) => {
        const thinkKey = `${sectionKeyPrefix}:think:${sectionIndex}`;
        const isThink = section.type === "think";
        const thinkExpanded = Boolean(expandedThinkKeys[thinkKey]);

        return (
          <div
            key={`${sectionKeyPrefix}:${section.type}:${sectionIndex}`}
            className={sectionIndex > 0 ? "mt-3" : ""}
          >
            {isThink ? (
              <div className="rounded-2xl border border-border/70 bg-surface/58">
                <div className="px-3 py-2">
                  <ThinkMessageChip
                    expanded={thinkExpanded}
                    onToggle={() => onToggleThinkSection(thinkKey)}
                  />
                </div>
                {thinkExpanded ? (
                  <div className="border-t border-border/60 px-3 py-3 text-[11px] text-muted">
                    <div className="ai-markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={MARKDOWN_COMPONENTS}
                      >
                        {section.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="ai-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                  {section.content}
                </ReactMarkdown>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function ToolMessageSection({
  message,
  withDivider = false,
  expanded,
  onToggle,
  resolvingActionId = "",
  onResolvePendingAction,
}) {
  const [resolutionComment, setResolutionComment] = useState("");
  const pendingAction = message.pendingAction || null;
  const pendingRisk = pendingRiskLabel(pendingAction?.riskLevel);
  const toolState = toolStateLabel(message.toolState);
  const pendingBusy = pendingAction && resolvingActionId === pendingAction.id;
  const { t } = useI18n();
  const actionAwaitingDecision = pendingAction?.status === "pending";
  const approvalDecisionLabel =
    pendingAction?.approvalDecision === "approved"
      ? t("Approved")
      : pendingAction?.approvalDecision === "rejected"
        ? t("Rejected")
        : "";

  return (
    <section key={message.id} className={withDivider ? "mt-3 border-t border-border/60 pt-3" : ""}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ToolMessageChip toolKind={message.toolKind} expanded={expanded} onToggle={onToggle} />
          {toolState ? (
            <span
              className={[
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                toolStateBadgeClass(message.toolState),
              ].join(" ")}
            >
              {t(toolState)}
            </span>
          ) : null}
          {pendingAction ? (
            <span
              className={[
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                pendingRiskBadgeClass(pendingRisk),
              ].join(" ")}
            >
              {t(pendingRisk)}
            </span>
          ) : null}
        </div>
        <span className="pt-1 text-[10px] uppercase tracking-[0.16em] text-warning/75">
          {formatTime(message.createdAt)}
        </span>
      </div>
      {pendingAction ? (
        <div className="mt-2 rounded-2xl border border-warning/35 bg-warning/8 px-3 py-2 text-[11px] text-text">
          <div className="font-medium">{t("Execute command request")}</div>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-warning/25 bg-panel/78 px-2.5 py-2 font-mono text-[12px] text-text">
            {pendingAction.command}
          </pre>
          {pendingAction.reason ? (
            <div className="mt-2 text-muted">
              {t("Reason")}: {t(pendingAction.reason)}
            </div>
          ) : null}
          {approvalDecisionLabel ? (
            <div className="mt-2 text-muted">
              {t("Decision")}: {approvalDecisionLabel}
            </div>
          ) : null}
          {pendingAction.approvalComment ? (
            <div className="mt-2 text-muted">
              {t("Reviewer note")}: {pendingAction.approvalComment}
            </div>
          ) : null}
          {expanded && pendingAction.executionOutput ? (
            <div className="mt-2">
              <div className="mb-1 text-muted">
                {pendingAction.status === "failed" ? t("Execution error") : t("Execution result")}
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-warning/25 bg-panel/78 px-2.5 py-2 font-mono text-[12px] text-text">
                {pendingAction.executionOutput}
              </pre>
            </div>
          ) : null}
          {actionAwaitingDecision ? (
            <textarea
              value={resolutionComment}
              disabled={pendingBusy}
              placeholder={t("Add guidance for the agent after this decision (optional)")}
              className="mt-2 min-h-18 w-full rounded-xl border border-warning/25 bg-panel/82 px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-muted/70 disabled:opacity-50"
              onChange={(event) => setResolutionComment(event.target.value)}
            />
          ) : null}
          {actionAwaitingDecision && typeof onResolvePendingAction === "function" ? (
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={pendingBusy}
                className="inline-flex items-center gap-1 rounded-xl border border-success/50 bg-success/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                onClick={() => onResolvePendingAction(pendingAction.id, true, resolutionComment)}
              >
                {pendingBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {t("Approve")}
              </button>
              <button
                type="button"
                disabled={pendingBusy}
                className="inline-flex items-center gap-1 rounded-xl border border-danger/50 bg-danger/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                onClick={() => onResolvePendingAction(pendingAction.id, false, resolutionComment)}
              >
                <X className="h-3.5 w-3.5" />
                {t("Reject")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {expanded && !pendingAction ? (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-2xl border border-warning/25 bg-panel/78 px-3 py-2 font-mono text-[12px] text-text">
          {message.content}
        </pre>
      ) : null}
    </section>
  );
}

function ToolCallRowContent({ message }) {
  const { t } = useI18n();
  const content = typeof message.content === "string" ? message.content : "";
  const lines = content.length > 0 ? content.split("\n") : [];
  const [copied, setCopied] = useState(false);
  const lineNumberWidth = String(lines.length || 1).length;

  const handleCopy = async () => {
    const ok = await copyText(content);
    if (!ok) {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (lines.length === 0) {
    return (
      <div className="px-3 py-2 font-mono text-[11px] italic text-muted">
        {t("No output")}
      </div>
    );
  }

  return (
    <div className="border-t border-border/45 bg-panel/72">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-muted">
        <span>{t("Full output ({count} lines)", { count: lines.length })}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border/55 bg-surface/55 px-1.5 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text"
          onClick={handleCopy}
          title={t("Copy")}
        >
          {copied ? (
            <CheckCircle2 className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? t("Copied") : t("Copy")}
        </button>
      </div>
      <div className="max-h-72 overflow-auto">
        <pre className="m-0 whitespace-pre font-mono text-[11px] leading-[1.55] text-text">
          {lines.map((line, index) => (
            <div
              key={index}
              className="flex items-start gap-3 px-3 py-0.5 hover:bg-surface/35"
            >
              <span
                className="select-none pt-px text-right text-muted/65"
                style={{ minWidth: `${lineNumberWidth + 0.5}ch` }}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 break-all">{line || " "}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function ToolCallRow({ message, expanded, onToggle }) {
  const { t } = useI18n();
  const toolState = toolStateLabel(message.toolState);

  return (
    <div className="border-b border-border/45 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] transition-colors hover:bg-accent-soft/35"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <TerminalSquare className="h-3 w-3" aria-hidden="true" />
          </span>
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text">
            {toolLabel(message.toolKind)}
          </span>
          {toolState ? (
            <span
              className={[
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                toolStateBadgeClass(message.toolState),
              ].join(" ")}
            >
              {t(toolState)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            {formatTime(message.createdAt)}
          </span>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          )}
        </div>
      </button>
      {expanded ? <ToolCallRowContent message={message} /> : null}
    </div>
  );
}

export function ToolCallsGroupSection({
  toolMessages,
  withDivider = false,
  expandedToolMessageIds,
  onToggleToolMessage,
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  if (!Array.isArray(toolMessages) || toolMessages.length === 0) {
    return null;
  }

  const total = toolMessages.length;
  const latestMessage = toolMessages[toolMessages.length - 1];
  const latestTime = formatTime(latestMessage?.createdAt);
  const summaryLabel = total === 1
    ? t("Invoked 1 tool")
    : t("Invoked {count} tools", { count: total });

  return (
    <section className={withDivider ? "mt-3 border-t border-border/60 pt-3" : ""}>
      {expanded ? (
        <div className="overflow-hidden rounded-2xl border border-border/75 bg-surface/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded={true}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft/35"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text">
                {t("Tool calls ({count})", { count: total })}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                {t("Hide tool calls")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                {latestTime}
              </span>
              <ChevronUp className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            </div>
          </button>
          <div>
            {toolMessages.map((message) => (
              <ToolCallRow
                key={message.id}
                message={message}
                expanded={Boolean(expandedToolMessageIds?.[message.id])}
                onToggle={() => onToggleToolMessage?.(message.id)}
              />
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          className="flex w-full items-center justify-between gap-2 rounded-2xl border border-border/75 bg-surface/65 px-3 py-2 text-left text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:border-accent/45 hover:bg-accent-soft/45 hover:text-text"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em]">
              {summaryLabel}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
              {latestTime}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          </div>
        </button>
      )}
    </section>
  );
}

export function StreamingMessageSection({
  content,
  sectionKeyPrefix,
  withDivider = false,
  expandedThinkKeys,
  onToggleThinkSection,
}) {
  const { t } = useI18n();
  const sections = splitOpsAgentMessageContent(content);

  return (
    <section
      key={`${sectionKeyPrefix}:streaming`}
      className={[
        "min-w-0 break-words [overflow-wrap:anywhere]",
        withDivider ? "mt-3 border-t border-border/60 pt-3" : "",
      ].join(" ")}
    >
      <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("Agent typing")}
      </div>
      {sections.length > 0 ? (
        sections.map((section, sectionIndex) => {
          const thinkKey = `${sectionKeyPrefix}:think:${sectionIndex}`;
          const thinkExpanded = Boolean(expandedThinkKeys[thinkKey]);

          return (
            <div
              key={`${sectionKeyPrefix}:${section.type}:${sectionIndex}`}
              className={sectionIndex > 0 ? "mt-3" : ""}
            >
              {section.type === "think" ? (
                <div className="rounded-2xl border border-border/70 bg-surface/58">
                  <div className="px-3 py-2">
                    <ThinkMessageChip
                      expanded={thinkExpanded}
                      onToggle={() => onToggleThinkSection(thinkKey)}
                    />
                  </div>
                  {thinkExpanded ? (
                    <div className="border-t border-border/60 px-3 py-3 text-[11px] text-muted">
                      <div className="ai-markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                          components={MARKDOWN_COMPONENTS}
                        >
                          {section.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="ai-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                    {section.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          );
        })
      ) : (
        <div className="ai-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
            {"..."}
          </ReactMarkdown>
        </div>
      )}
    </section>
  );
}
