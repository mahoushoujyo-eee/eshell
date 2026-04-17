import { Check, Copy } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import {
  getOpsAgentAssistantReplyText,
  getOpsAgentLatestAssistantReplyText,
} from "../../../lib/ops-agent-message-rendering";
import { messageActionButtonClass } from "./aiAssistantUtils";
import {
  AssistantMessageSection,
  StreamingMessageSection,
  ToolMessageSection,
} from "./AiTurnSections";

export default function AiAgentTurn({
  group,
  isDrawer,
  copiedMessageKey,
  expandedThinkKeys,
  expandedToolMessageIds,
  resolvingActionId,
  onCopyMessage,
  onResolvePendingAction,
  onToggleThinkSection,
  onToggleToolMessage,
}) {
  const { t } = useI18n();
  const turnCopyText = group.isStreaming
    ? getOpsAgentAssistantReplyText(group.streamingText) ||
      getOpsAgentLatestAssistantReplyText(group.messages)
    : getOpsAgentLatestAssistantReplyText(group.messages);

  return (
    <div className="flex justify-center">
      <article
        className={[
          "min-w-0 w-full max-w-[46rem] overflow-x-hidden px-2 py-2 text-[13px] text-text",
          isDrawer ? "sm:px-3" : "",
        ].join(" ")}
      >
        {group.messages.map((message, index) => {
          if (message.role === "tool") {
            return (
              <ToolMessageSection
                key={message.id}
                message={message}
                withDivider={index > 0}
                expanded={Boolean(expandedToolMessageIds[message.id])}
                resolvingActionId={resolvingActionId}
                onResolvePendingAction={onResolvePendingAction}
                onToggle={() => onToggleToolMessage(message.id)}
              />
            );
          }
          if (message.role === "assistant") {
            return (
              <AssistantMessageSection
                key={message.id || `${group.id}:${index}`}
                message={message}
                sectionKeyPrefix={`${group.id}:${message.id || index}`}
                withDivider={index > 0}
                expandedThinkKeys={expandedThinkKeys}
                onToggleThinkSection={onToggleThinkSection}
              />
            );
          }

          return (
            <section
              key={message.id || `${group.id}:plain:${index}`}
              className={index > 0 ? "mt-3 border-t border-border/60 pt-3" : ""}
            >
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{message.content}</pre>
            </section>
          );
        })}
        {Array.isArray(group.streamingToolCalls)
          ? group.streamingToolCalls.map((message, index) => (
              <ToolMessageSection
                key={message.id}
                message={message}
                withDivider={group.messages.length > 0 || index > 0}
                expanded={Boolean(expandedToolMessageIds[message.id])}
                resolvingActionId={resolvingActionId}
                onResolvePendingAction={onResolvePendingAction}
                onToggle={() => onToggleToolMessage(message.id)}
              />
            ))
          : null}
        {group.isStreaming ? (
          <StreamingMessageSection
            content={group.streamingText}
            sectionKeyPrefix={`${group.id}:streaming`}
            withDivider={group.messages.length > 0 || (group.streamingToolCalls?.length || 0) > 0}
            expandedThinkKeys={expandedThinkKeys}
            onToggleThinkSection={onToggleThinkSection}
          />
        ) : null}
        {turnCopyText ? (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className={[
                messageActionButtonClass,
                "border-transparent bg-transparent px-2 text-[10px] shadow-none hover:border-border/55 hover:bg-surface/50",
                copiedMessageKey === group.id
                  ? "border-success/45 bg-success/10 text-success hover:border-success/45 hover:bg-success/10 hover:text-success"
                  : "",
              ].join(" ")}
              onClick={() => onCopyMessage(group.id, turnCopyText)}
              title={t("Copy latest AI reply")}
            >
              {copiedMessageKey === group.id ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copiedMessageKey === group.id ? t("Copied") : t("Copy")}
            </button>
          </div>
        ) : null}
      </article>
    </div>
  );
}
