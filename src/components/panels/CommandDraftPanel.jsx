import { useState } from "react";
import { NotebookPen, Send } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import Button from "../ui/Button";
import PanelHeader from "../ui/PanelHeader";

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
      <PanelHeader
        icon={NotebookPen}
        title={t("Command Draft")}
        actions={
          <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[10.5px] leading-4 text-muted">
            Ctrl+Enter
          </kbd>
        }
      />

      <div className="min-h-0 flex-1">
        <textarea
          className="scroll-region h-full w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-text placeholder:text-subtle focus:outline-none disabled:cursor-not-allowed"
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

      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-border px-2.5">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted select-none">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={clearAfterSend}
            onChange={(event) => setClearAfterSend(event.target.checked)}
          />
          {t("Clear after send")}
        </label>
        <Button variant="primary" size="sm" disabled={!canSend} onClick={handleSend}>
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Send")}
        </Button>
      </div>
    </div>
  );
}
