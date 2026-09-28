import { Plus } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import EshellAiMark from "../../ai/EshellAiMark";

export default function XtermSelectionAction({ selectionLength, onClick }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className="absolute top-2.5 right-3 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-elevated pr-1.5 pl-2 text-xs font-medium text-text shadow-overlay transition-colors hover:border-accent/50 hover:bg-accent-soft"
      onClick={onClick}
      title={t("Attach terminal selection to the agent")}
    >
      <EshellAiMark className="h-4 w-4 text-muted" />
      <span>{t("Add To Agent")}</span>
      <span className="rounded bg-hover px-1.5 font-mono text-[10.5px] leading-5 text-muted">
        {selectionLength}
      </span>
      <Plus className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
    </button>
  );
}
