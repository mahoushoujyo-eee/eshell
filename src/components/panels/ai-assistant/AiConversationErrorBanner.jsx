import { AlertTriangle } from "lucide-react";

export default function AiConversationErrorBanner({
  conversationErrorText,
  onClearConversationError,
}) {
  if (!conversationErrorText) {
    return null;
  }

  return (
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
  );
}
