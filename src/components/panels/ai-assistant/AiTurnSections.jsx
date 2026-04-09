import { Check, Loader2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { splitOpsAgentMessageContent } from "../../../lib/ops-agent-message-rendering";
import {
  MARKDOWN_COMPONENTS,
  formatTime,
  pendingRiskBadgeClass,
  pendingRiskLabel,
  toolStateBadgeClass,
  toolStateLabel,
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
  const pendingAction = message.pendingAction || null;
  const pendingRisk = pendingRiskLabel(pendingAction?.riskLevel);
  const toolState = toolStateLabel(message.toolState);
  const pendingBusy = pendingAction && resolvingActionId === pendingAction.id;

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
              {toolState}
            </span>
          ) : null}
          {pendingAction ? (
            <span
              className={[
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                pendingRiskBadgeClass(pendingRisk),
              ].join(" ")}
            >
              {pendingRisk}
            </span>
          ) : null}
        </div>
        <span className="pt-1 text-[10px] uppercase tracking-[0.16em] text-[#8a5a00]/80">
          {formatTime(message.createdAt)}
        </span>
      </div>
      {pendingAction ? (
        <div className="mt-2 rounded-2xl border border-[#efc77a] bg-[#fff8e8] px-3 py-2 text-[11px] text-[#714800]">
          <div className="font-medium">{pendingAction.reason || "approval required"}</div>
          {expanded ? (
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] text-[#5f3e00]">
              {pendingAction.command}
            </pre>
          ) : null}
          {typeof onResolvePendingAction === "function" ? (
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={pendingBusy}
                className="inline-flex items-center gap-1 rounded-xl border border-success/50 bg-success/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                onClick={() => onResolvePendingAction(pendingAction.id, true)}
              >
                {pendingBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Approve
              </button>
              <button
                type="button"
                disabled={pendingBusy}
                className="inline-flex items-center gap-1 rounded-xl border border-danger/50 bg-danger/85 px-2.5 py-1.5 text-white disabled:opacity-40"
                onClick={() => onResolvePendingAction(pendingAction.id, false)}
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {expanded && !pendingAction ? (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-2xl border border-[#efc77a] bg-[#fff8e8] px-3 py-2 font-mono text-[12px] text-[#5f3e00]">
          {message.content}
        </pre>
      ) : null}
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
        Agent typing
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
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
          {"..."}
        </ReactMarkdown>
      )}
    </section>
  );
}
