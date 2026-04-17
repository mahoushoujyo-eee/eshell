import { Archive, Bot, ChevronLeft, ChevronRight, Loader2, Plus, Settings2, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { HeaderActionButton } from "./AiAssistantControls";

export default function AiAssistantHeader({
  hasManagedShell,
  isDrawer,
  historyVisible,
  onToggleHistory,
  onCreateConversation,
  onCompactConversation,
  compactBusy = false,
  canCompact = false,
  onOpenAiConfig,
  onClose,
}) {
  const { t } = useI18n();

  if (!hasManagedShell) {
    return null;
  }

  return (
    <header
      className={[
        "flex items-center gap-3 border-b border-border/70",
        isDrawer ? "px-4 py-3" : "bg-panel px-3 py-3",
      ].join(" ")}
    >
      <div className="flex flex-1 items-center">
        <span
          className={[
            "inline-flex h-10 w-10 items-center justify-center rounded-2xl text-accent",
            isDrawer
              ? "border border-accent/35 bg-accent-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]"
              : "border border-border/70 bg-surface/70",
          ].join(" ")}
        >
          <Bot className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <HeaderActionButton
          title={historyVisible ? t("Hide chat history") : t("Show chat history")}
          onClick={onToggleHistory}
        >
          {historyVisible ? (
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </HeaderActionButton>
        <HeaderActionButton title={t("New conversation")} onClick={onCreateConversation}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </HeaderActionButton>
        {onCompactConversation ? (
          <HeaderActionButton
            title={compactBusy ? t("Compacting conversation") : t("Compact conversation")}
            onClick={compactBusy ? undefined : onCompactConversation}
            disabled={!canCompact || compactBusy}
          >
            {compactBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Archive className="h-4 w-4" aria-hidden="true" />
            )}
          </HeaderActionButton>
        ) : null}
        {onOpenAiConfig ? (
          <HeaderActionButton title={t("AI config")} onClick={onOpenAiConfig}>
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </HeaderActionButton>
        ) : null}
        {onClose ? (
          <HeaderActionButton title={t("Close AI chat")} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </HeaderActionButton>
        ) : null}
      </div>
    </header>
  );
}
