import { cx } from "./cx";

const SIZES = {
  // Fits inside the 32px panel header.
  "2xs": "h-5 px-1.5 text-[11px]",
  xs: "h-6 px-2 text-[11px]",
  sm: "h-7 px-2.5 text-xs",
};

/**
 * A row of mutually exclusive options. `options` is
 * `[{ id, label, icon?, title?, trailing? }]`; the active option is raised
 * onto the elevated surface rather than filled with the accent, so a
 * segmented control never competes with the primary button next to it.
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  size = "xs",
  ariaLabel,
  className = "",
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx("inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5", className)}
    >
      {options.map((option) => {
        const active = option.id === value;
        const OptionIcon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            className={cx(
              "inline-flex items-center gap-1.5 rounded-[4px] whitespace-nowrap transition-colors duration-150",
              SIZES[size] || SIZES.xs,
              active
                ? "bg-elevated font-medium text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border"
                : "text-muted hover:text-text",
            )}
            aria-pressed={active}
            title={option.title}
            onClick={() => onChange?.(option.id)}
          >
            {OptionIcon ? <OptionIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            {option.label}
            {option.trailing !== undefined && option.trailing !== null ? (
              <span className="tabular-nums text-subtle">{option.trailing}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
