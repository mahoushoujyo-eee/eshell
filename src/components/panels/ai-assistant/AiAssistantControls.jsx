import { ChevronDown, ChevronRight, TerminalSquare, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { actionButtonClass, toolLabel } from "./aiAssistantUtils";

export function HeaderActionButton({ title, onClick, children, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      className={actionButtonClass}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function ShellContextChip({
  shellContext,
  expanded = false,
  onToggle,
  removable = false,
  onRemove,
  inverted = false,
}) {
  const { t } = useI18n();
  const interactive = typeof onToggle === "function";
  const frameClass = inverted
    ? "border-white/18 bg-white/10 text-white hover:border-white/28 hover:bg-white/14"
    : "border-border/75 bg-surface/78 text-text hover:border-accent/35 hover:bg-accent-soft/55";
  const iconClass = inverted ? "bg-white/14 text-white" : "bg-accent-soft text-accent";
  const buttonClass = interactive ? "transition-colors" : "";

  const body = (
    <>
      <span
        className={[
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          iconClass,
        ].join(" ")}
      >
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div
          className={[
            "truncate text-[10px] font-semibold uppercase tracking-[0.16em]",
            inverted ? "text-white/70" : "text-muted",
          ].join(" ")}
        >
          {t("Shell Context / {name}", { name: shellContext.sessionName })}
        </div>
        {!interactive ? (
          <div
            className={["truncate font-mono text-[11px]", inverted ? "text-white" : "text-text"].join(
              " ",
            )}
          >
            {shellContext.preview}
          </div>
        ) : null}
      </div>
      <span
        className={[
          "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
          inverted ? "bg-white/12 text-white/80" : "bg-warm text-muted",
        ].join(" ")}
      >
        {shellContext.charCount}
      </span>
      {interactive ? (
        expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )
      ) : null}
      {removable ? (
        <button
          type="button"
          className={[
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
            inverted ? "hover:bg-white/10" : "hover:bg-black/5",
          ].join(" ")}
          onClick={onRemove}
          title={t("Remove selected shell context")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={[
          "inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-left text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
          frameClass,
          buttonClass,
        ].join(" ")}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      className={[
        "inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
        frameClass,
      ].join(" ")}
    >
      {body}
    </div>
  );
}

export function ToolMessageChip({ toolKind, expanded = false, onToggle }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-2.5 py-1.5 text-left text-[11px] text-warning shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:border-warning/55 hover:bg-warning/14"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? t("Hide tool details") : t("Show tool details")}
    >
      <span className="rounded-full bg-warning/18 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-warning">
        {toolLabel(toolKind)}
      </span>
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

export function ThinkMessageChip({ expanded = false, onToggle }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border border-border/75 bg-surface/72 px-2.5 py-1.5 text-left text-[11px] text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:border-accent/35 hover:bg-accent-soft/50 hover:text-text"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? t("Hide model reasoning") : t("Show model reasoning")}
    >
      <span className="rounded-full bg-warm px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {t("think")}
      </span>
      <span className="truncate">
        {expanded ? t("Hide model reasoning") : t("Show model reasoning")}
      </span>
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}
