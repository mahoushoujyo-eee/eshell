import { Check, CheckCircle2, Copy, Loader2 } from "lucide-react";
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

const agentKindLabel = (agentKind) => {
  if (agentKind === "planner") {
    return "Planner";
  }
  if (agentKind === "executor") {
    return "Executor";
  }
  if (agentKind === "reviewer") {
    return "Reviewer";
  }
  if (agentKind === "validator") {
    return "Validator";
  }
  if (agentKind === "orchestrator") {
    return "Orchestrator";
  }
  return "Agent";
};

const phaseLabel = (phase) => {
  if (phase === "planning") {
    return "planning";
  }
  if (phase === "executing") {
    return "executing";
  }
  if (phase === "reviewing") {
    return "reviewing";
  }
  if (phase === "validating") {
    return "validating";
  }
  if (phase === "answering") {
    return "answering";
  }
  return "";
};

function AgentProgressSection({ progress, withDivider = false }) {
  const { t } = useI18n();
  if (!progress) {
    return null;
  }

  const status = progress.status || "running";
  const done = status === "completed";
  const agent = agentKindLabel(progress.agentKind);
  const phase = phaseLabel(progress.phase);
  const stepText =
    Number.isFinite(progress.stepIndex) && Number.isFinite(progress.stepTotal)
      ? `${progress.stepIndex}/${progress.stepTotal}`
      : "";

  return (
    <section className={withDivider ? "mt-3 border-t border-border/60 pt-3" : ""}>
      <div className="rounded-md border border-accent/25 bg-accent-soft/35 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={[
              "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
              done
                ? "border-success/35 bg-success/12 text-success"
                : "border-accent/35 bg-accent-soft text-accent",
            ].join(" ")}
          >
            {done ? (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-panel/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
                {t(agent)}
              </span>
              {phase ? (
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted">
                  {t(phase)}
                </span>
              ) : null}
              {stepText ? (
                <span className="font-mono text-[10px] text-muted">{stepText}</span>
              ) : null}
            </div>
            <div className="mt-1 truncate text-[12px] font-medium text-text">
              {progress.title ? t(progress.title) : t(agent)}
            </div>
            {progress.message ? (
              <div className="mt-1 truncate font-mono text-[11px] text-muted">
                {progress.message}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

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
        {group.isStreaming && group.streamingAgentProgress ? (
          <AgentProgressSection
            progress={group.streamingAgentProgress}
            withDivider={group.messages.length > 0}
          />
        ) : null}
        {Array.isArray(group.streamingToolCalls)
          ? group.streamingToolCalls.map((message, index) => (
              <ToolMessageSection
                key={message.id}
                message={message}
                withDivider={
                  group.messages.length > 0 ||
                  Boolean(group.streamingAgentProgress) ||
                  index > 0
                }
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
            withDivider={
              group.messages.length > 0 ||
              Boolean(group.streamingAgentProgress) ||
              (group.streamingToolCalls?.length || 0) > 0
            }
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
