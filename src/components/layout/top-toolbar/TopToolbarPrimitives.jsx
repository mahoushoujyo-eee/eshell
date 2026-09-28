import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { cx } from "../../ui/cx";

// Left accent bar marking a toggled-on panel. Hover and selection share the
// same row shape, so state reads from colour and this bar alone.
const ACTIVE_BAR =
  "before:absolute before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-accent before:content-['']";

/**
 * `label` is the visible name in the expanded rail; `title` (defaults to the
 * label) is the tooltip and accessible name, so a toggle can show "SFTP"
 * while announcing "Hide SFTP panel".
 */
export function RailButton({
  icon: Icon,
  label,
  title,
  onClick,
  collapsed = false,
  active = false,
  trailing = null,
}) {
  const hint = title || label;
  if (collapsed) {
    return (
      <button
        type="button"
        title={hint}
        aria-label={hint}
        className={cx(
          "relative mx-auto flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-150",
          active
            ? cx("bg-accent-soft text-accent before:-left-2", ACTIVE_BAR)
            : "text-muted hover:bg-hover hover:text-text",
        )}
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
      title={hint !== label ? hint : undefined}
      aria-label={hint !== label ? hint : undefined}
      className={cx(
        "relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-150",
        active
          ? cx("bg-accent-soft font-medium text-text before:left-0", ACTIVE_BAR)
          : "text-muted hover:bg-hover hover:text-text",
      )}
      onClick={onClick}
    >
      <Icon className={cx("h-4 w-4 shrink-0", active ? "text-accent" : "")} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {typeof trailing === "function" ? trailing(false, active) : trailing}
    </button>
  );
}

/**
 * One labelled group of rail buttons.
 *
 * `scroll` makes the section's body scroll instead of growing without bound.
 * The Panels section needs it: every enabled plugin contributes a button, so
 * an unbounded list would push the Quick section off the bottom of the rail
 * with no way to reach it. The header stays put and only the buttons scroll,
 * so the group remains identifiable while scrolled.
 *
 * `min-h-0` is required for the flex child to shrink below its content size;
 * without it the section would overflow its parent instead of scrolling.
 */
export function ToolbarSection({ title, collapsed, scroll = false, children }) {
  return (
    <div className={scroll ? "flex min-h-0 flex-col" : ""}>
      {collapsed ? (
        <div className="mx-auto mb-1.5 h-px w-6 shrink-0 bg-border" aria-hidden="true" />
      ) : (
        <div className="mb-1 shrink-0 px-2.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">
          {title}
        </div>
      )}
      <div
        className={cx(
          "space-y-0.5",
          scroll ? "scroll-region min-h-0 flex-1 overflow-y-auto" : "",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ToggleSidebarButton({ collapsed, onClick }) {
  const { t } = useI18n();
  const label = collapsed ? t("Expand sidebar") : t("Collapse sidebar");
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
      onClick={onClick}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/** Trailing visibility dot for panel toggles in the expanded rail. */
export function panelVisibilityMarker(collapsed, active) {
  if (collapsed) {
    return null;
  }
  return (
    <span
      className={cx(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        active ? "bg-accent" : "border border-border-strong",
      )}
      aria-hidden="true"
    />
  );
}
