import { Bot, Send, X } from "lucide-react";
import { ShellContextChip } from "./AiAssistantControls";

export default function AiComposer({
  isDrawer,
  shellContext,
  onClearShellContext,
  aiQuestion,
  setAiQuestion,
  onAskAi,
  onCancelStreaming,
  isStreaming,
  activeConversationId,
  activeConversation,
  hasManagedShell,
  onClose,
}) {
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
  );
}
