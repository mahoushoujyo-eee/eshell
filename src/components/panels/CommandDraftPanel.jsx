import { useState } from "react";
import { NotebookPen, Send } from "lucide-react";
import { useI18n } from "../../lib/i18n";

export default function CommandDraftPanel({
  activeSessionId,
  draft,
  onDraftChange,
  onSend,
}) {
  const { t } = useI18n();
  const [clearAfterSend, setClearAfterSend] = useState(false);
  const canSend = Boolean(activeSessionId) && draft.trim().length > 0;

  const handleSend = () => {
    if (!canSend) {
      return;
    }
    onSend(draft);
    if (clearAfterSend) {
      onDraftChange("");
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-xs">
      <div className="flex items-center justify-between border-b border-border px-2 py-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <NotebookPen className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("Command Draft")}
        </div>
        <span className="text-muted">Ctrl+Enter</span>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <textarea
          className="h-full w-full resize-none border border-transparent bg-transparent px-2 py-2 font-mono text-sm text-text placeholder:text-muted focus:outline-none"
          placeholder={
            activeSessionId
              ? t("Draft commands here, one line per command...")
              : t("Connect a session first")
          }
          value={draft}
          disabled={!activeSessionId}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted select-none">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={clearAfterSend}
            onChange={(event) => setClearAfterSend(event.target.checked)}
          />
          {t("Clear after send")}
        </label>
        <button
          type="button"
          disabled={!canSend}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          onClick={handleSend}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {t("Send")}
        </button>
      </div>
    </div>
  );
}
