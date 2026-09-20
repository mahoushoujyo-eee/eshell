// Class tokens shared by the UI primitives.
//
// Only eShell's own theme colours are used (`bg-panel`, `border-border`,
// `text-muted`, `text-accent`, `bg-accent-soft`, `text-success`,
// `text-warning`, `text-danger`, `bg-warm`, `bg-surface`). No hardcoded
// colours and no global styles: the panel follows the app's light/dark theme,
// and nothing here leaks outside the panel's own subtree.

export const cx = (...parts) => parts.filter(Boolean).join(" ");

export const TONE_TEXT = {
  neutral: "text-muted",
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export const TONE_DOT = {
  neutral: "bg-muted",
  info: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export const BUTTON_TONES = {
  default: "border-border bg-surface text-text hover:bg-accent-soft",
  primary: "border-accent bg-accent text-white hover:opacity-90",
  danger: "border-danger text-danger hover:bg-danger/10",
  ghost: "border-transparent text-muted hover:bg-accent-soft hover:text-text",
};

export const SIZES = {
  xs: "px-1.5 py-0.5 text-[11px]",
  sm: "px-2 py-1 text-[11px]",
  md: "px-2.5 py-1.5 text-xs",
};

export const INPUT_CLASS =
  "min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted/70 focus:border-accent disabled:opacity-50";

export const LABEL_CLASS = "text-[10px] font-medium tracking-wide text-muted uppercase";
