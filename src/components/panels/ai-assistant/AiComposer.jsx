import { Send, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { ShellContextChip } from "./AiAssistantControls";

export default function AiComposer({
  isDrawer,
  approvalMode,
  shellContext,
  onClearShellContext,
  aiQuestion,
  setAiQuestion,
  onAskAi,
  onCancelStreaming,
  onSaveApprovalMode,
  isStreaming,
  activeConversationId,
  activeConversation,
  hasManagedShell,
  onClose,
}) {
  const { t } = useI18n();
  const isAutoExecute = approvalMode === "auto_execute";
  const ApprovalIcon = isAutoExecute ? ShieldAlert : ShieldCheck;

  const handleInputKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    onAskAi(event);
  };

  return (
    <form
      className={[
        "shrink-0 border-t border-border/70 px-3 py-3",
        isDrawer ? "bg-surface/42" : "bg-panel",
      ].join(" ")}
      onSubmit={onAskAi}
    >
      {shellContext ? (
        <div className="mb-2 flex items-center">
          <ShellContextChip shellContext={shellContext} removable onRemove={onClearShellContext} />
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
        placeholder={t("Ask the ops agent about diagnostics, root cause, or safe commands...")}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {activeConversationId
            ? t("Conversation: {title}", {
                title: activeConversation?.title || activeConversationId,
              })
            : t("No active conversation")}
          {hasManagedShell && onClose ? t(" / Esc to close") : ""}
        </span>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <div
            className={[
              "inline-flex max-w-full items-center gap-1 rounded-full border px-1 py-1 text-[11px]",
              isAutoExecute
                ? "border-warning/35 bg-warning/10 text-warning"
                : "border-accent/20 bg-accent/8 text-accent",
            ].join(" ")}
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/55">
              <ApprovalIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </span>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (approvalMode !== "require_approval") {
                    onSaveApprovalMode("require_approval");
                  }
                }}
                className={[
                  "rounded-full px-2.5 py-1 font-medium transition-colors",
                  !isAutoExecute
                    ? "bg-white/80 text-accent shadow-sm"
                    : "text-muted hover:bg-white/40",
                ].join(" ")}
              >
                {t("Approval")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (approvalMode !== "auto_execute") {
                    onSaveApprovalMode("auto_execute");
                  }
                }}
                className={[
                  "rounded-full px-2.5 py-1 font-medium transition-colors",
                  isAutoExecute
                    ? "bg-white/80 text-warning shadow-sm"
                    : "text-muted hover:bg-white/40",
                ].join(" ")}
              >
                {t("Full Access")}
              </button>
            </div>
          </div>

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
            {isStreaming ? t("Stop") : t("Send")}
          </button>
        </div>
      </div>
    </form>
  );
}
