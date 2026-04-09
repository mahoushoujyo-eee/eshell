import { ChevronLeft, ChevronRight, CircleCheck } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export function RailButton({
  icon: Icon,
  label,
  onClick,
  collapsed = false,
  active = false,
  trailing = null,
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        className={[
          "relative inline-flex h-11 w-full items-center justify-center rounded-2xl border transition-all",
          active
            ? "border-accent/55 bg-accent-soft text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
            : "border-border/75 bg-panel/90 text-muted hover:border-accent/40 hover:bg-accent-soft hover:text-text",
        ].join(" ")}
        onClick={onClick}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        {typeof trailing === "function" ? trailing(true, active) : null}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={[
        "inline-flex w-full items-center rounded-xl border px-3 py-2 text-sm transition-colors",
        active
          ? "border-accent bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]"
          : "border-border/75 bg-panel text-muted hover:border-accent/40 hover:bg-accent-soft hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      {typeof trailing === "function" ? trailing(false, active) : trailing}
    </button>
  );
}

export function StatusIndicator({
  collapsed,
  icon: Icon,
  label,
  tone = "muted",
  spin = false,
  title,
}) {
  const toneClass = {
    muted: "text-muted",
    accent: "text-accent",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone];

  if (collapsed) {
    return (
      <div
        className={["inline-flex h-9 w-full items-center justify-center rounded-xl", toneClass].join(
          " ",
        )}
        title={title || label}
        aria-label={label}
      >
        <Icon className={["h-4 w-4", spin ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className={["inline-flex w-full items-center gap-1.5", toneClass].join(" ")}
      title={title || label}
    >
      <Icon
        className={["h-3.5 w-3.5 shrink-0", spin ? "animate-spin" : ""].join(" ")}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </div>
  );
}

export function ToolbarSection({ title, collapsed, children }) {
  return (
    <div
      className={[
        "rounded-2xl border border-border/70 bg-panel/70",
        collapsed ? "p-1.5" : "p-2",
      ].join(" ")}
    >
      {!collapsed ? (
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          {title}
        </div>
      ) : null}
      <div className={collapsed ? "space-y-1.5" : "space-y-1"}>{children}</div>
    </div>
  );
}

export function ToggleSidebarButton({ collapsed, onClick }) {
  const { t } = useI18n();
  const label = collapsed ? t("Expand sidebar") : t("Collapse sidebar");

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/75 bg-panel/92 text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text"
      onClick={onClick}
    >
      {collapsed ? (
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      ) : (
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}

export function panelVisibilityMarker(collapsed, active) {
  if (collapsed) {
    return (
      <span
        className={[
          "absolute right-2 bottom-2 h-2.5 w-2.5 rounded-full border border-panel",
          active ? "bg-success" : "bg-border",
        ].join(" ")}
      />
    );
  }

  return active ? (
    <CircleCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
  ) : (
    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-border" aria-hidden="true" />
  );
}
