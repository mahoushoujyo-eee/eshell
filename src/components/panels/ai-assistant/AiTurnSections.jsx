import { Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { splitOpsAgentMessageContent } from "../../../lib/ops-agent-message-rendering";
import { MARKDOWN_COMPONENTS } from "./aiAssistantUtils";
import { ThinkMessageChip, ToolMessageChip } from "./AiAssistantControls";
import { formatTime } from "./aiAssistantUtils";

export function AssistantMessageSection({
  message,
  sectionKeyPrefix,
  withDivider = false,
  expandedThinkKeys,
  onToggleThinkSection,
}) {
  const sections = splitOpsAgentMessageContent(message.content);

  return (
    <section
      key={message.id || sectionKeyPrefix}
      className={[
        "min-w-0 break-words [overflow-wrap:anywhere]",
        withDivider ? "mt-3 border-t border-border/60 pt-3" : "",
      ].join(" ")}
    >
      {sections.length > 0 ? (
        sections.map((section, sectionIndex) => {
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
        })
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{message.content}</pre>
      )}
    </section>
  );
}

export function ToolMessageSection({ message, withDivider = false, expanded, onToggle }) {
  return (
    <section key={message.id} className={withDivider ? "mt-3 border-t border-border/60 pt-3" : ""}>
      <div className="flex items-start justify-between gap-2">
        <ToolMessageChip toolKind={message.toolKind} expanded={expanded} onToggle={onToggle} />
        <span className="pt-1 text-[10px] uppercase tracking-[0.16em] text-[#8a5a00]/80">
          {formatTime(message.createdAt)}
        </span>
      </div>
      {expanded ? (
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
          {content || "..."}
        </ReactMarkdown>
      )}
    </section>
  );
}
