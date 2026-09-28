import { cx } from "./cx";

/**
 * The 32px header every bottom-dock panel shares: icon, title, optional
 * meta text, and right-aligned actions.
 */
export default function PanelHeader({ icon: Icon, title, meta, actions, className = "", children }) {
  return (
    <header
      className={cx(
        "flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-2.5",
        className,
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" /> : null}
      <h3 className="shrink-0 text-xs font-semibold text-text">{title}</h3>
      {meta ? <div className="min-w-0 truncate text-[11px] text-muted">{meta}</div> : null}
      {children}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </header>
  );
}
