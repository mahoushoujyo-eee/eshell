import { cx } from "./cx";

const VARIANTS = {
  primary: "border-transparent bg-accent font-medium text-on-accent hover:bg-accent/88",
  secondary: "border-border-strong bg-transparent text-text hover:bg-hover",
  ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-text",
  // Tinted rather than solid: a solid danger fill needs white text in light
  // mode and dark text in dark mode, a tint reads in both.
  danger: "border-danger/35 bg-danger/10 font-medium text-danger hover:bg-danger/18",
};

const SIZES = {
  xs: "h-6 gap-1 px-2 text-[11px]",
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-8 gap-2 px-3 text-[13px]",
};

export const buttonClass = ({ variant = "secondary", size = "sm", className = "" } = {}) =>
  cx(
    "inline-flex shrink-0 items-center justify-center rounded-md border whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant] || VARIANTS.secondary,
    SIZES[size] || SIZES.sm,
    className,
  );

export default function Button({
  variant = "secondary",
  size = "sm",
  className = "",
  type = "button",
  children,
  ...rest
}) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...rest}>
      {children}
    </button>
  );
}

const ICON_SIZES = {
  xs: "h-6 w-6",
  sm: "h-7 w-7",
  md: "h-8 w-8",
};

export const iconButtonClass = ({ size = "sm", active = false, tone = "default", className = "" } = {}) =>
  cx(
    "inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
    ICON_SIZES[size] || ICON_SIZES.sm,
    active
      ? "bg-accent-soft text-accent"
      : tone === "danger"
        ? "text-muted hover:bg-danger/12 hover:text-danger"
        : "text-muted hover:bg-hover hover:text-text",
    className,
  );

/** Square icon-only button; `label` becomes both the tooltip and the accessible name. */
export function IconButton({
  label,
  size = "sm",
  active = false,
  tone = "default",
  className = "",
  type = "button",
  children,
  ...rest
}) {
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      className={iconButtonClass({ size, active, tone, className })}
      {...rest}
    >
      {children}
    </button>
  );
}
