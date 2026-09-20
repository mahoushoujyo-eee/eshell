// Buttons, inputs and other small controls, built against the HOST React
// instance so the plugin never bundles a second renderer.
//
// Identical in shape to the Docker panel's primitives: a plugin can only
// import its own files, so each installable directory carries its own copy.

import { BUTTON_TONES, INPUT_CLASS, LABEL_CLASS, SIZES, TONE_DOT, TONE_TEXT, cx } from "./tokens.js";

export function createControls(react) {
  const { createElement: h } = react;

  const Spinner = ({ className }) =>
    h("span", {
      className: cx(
        "inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent align-[-1px]",
        className,
      ),
      "aria-hidden": "true",
    });

  const Dot = ({ tone = "neutral", title, pulse }) =>
    h("span", {
      className: cx(
        "h-2 w-2 shrink-0 rounded-full",
        TONE_DOT[tone] || TONE_DOT.neutral,
        pulse && "animate-pulse",
      ),
      title,
    });

  const Pill = ({ tone = "neutral", children, title, className }) =>
    h(
      "span",
      {
        className: cx(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none",
          TONE_TEXT[tone] || TONE_TEXT.neutral,
          className,
        ),
        title,
      },
      children,
    );

  const Mono = ({ children, className, title }) =>
    h("span", { className: cx("font-mono text-[11px]", className), title }, children);

  const Button = ({
    label,
    children,
    onClick,
    disabled,
    busy,
    tone = "default",
    size = "sm",
    title,
    type = "button",
    className,
  }) =>
    h(
      "button",
      {
        type,
        title: title || (typeof label === "string" ? label : undefined),
        disabled: disabled || busy,
        onClick,
        className: cx(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          BUTTON_TONES[tone] || BUTTON_TONES.default,
          SIZES[size] || SIZES.sm,
          className,
        ),
      },
      busy ? h(Spinner, { key: "spinner" }) : null,
      label ?? children,
    );

  const TextInput = ({
    value,
    onChange,
    onEnter,
    placeholder,
    disabled,
    className,
    ariaLabel,
    type = "text",
    autoFocus,
  }) =>
    h("input", {
      type,
      value: value ?? "",
      placeholder,
      disabled,
      autoFocus,
      spellCheck: false,
      "aria-label": ariaLabel || placeholder,
      onChange: (event) => onChange?.(event.target.value),
      onKeyDown: onEnter
        ? (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onEnter(event.target.value);
            }
          }
        : undefined,
      className: cx(INPUT_CLASS, className),
    });

  const TextArea = ({ value, onChange, placeholder, rows = 4, className, ariaLabel, disabled }) =>
    h("textarea", {
      value: value ?? "",
      placeholder,
      rows,
      disabled,
      spellCheck: false,
      "aria-label": ariaLabel || placeholder,
      onChange: (event) => onChange?.(event.target.value),
      className: cx(
        "w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text outline-none focus:border-accent",
        className,
      ),
    });

  const Select = ({ value, options, onChange, disabled, ariaLabel, title, className }) =>
    h(
      "select",
      {
        value: value ?? "",
        disabled,
        title,
        "aria-label": ariaLabel || title,
        onChange: (event) => onChange?.(event.target.value),
        className: cx(
          "shrink-0 rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-text outline-none focus:border-accent disabled:opacity-50",
          className,
        ),
      },
      (options || []).map((option) =>
        h(
          "option",
          { key: String(option.value), value: String(option.value) },
          option.label ?? String(option.value),
        ),
      ),
    );

  const Checkbox = ({ checked, onChange, label, title, disabled }) =>
    h(
      "label",
      {
        className: cx(
          "inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted",
          disabled ? "opacity-50" : "cursor-pointer hover:text-text",
        ),
        title,
      },
      h("input", {
        type: "checkbox",
        checked: Boolean(checked),
        disabled,
        onChange: (event) => onChange?.(event.target.checked),
        className: "h-3 w-3",
      }),
      label,
    );

  /** A radio-style row of small buttons; each one names its CLI flag in `title`. */
  const Segmented = ({ value, options, onChange, className }) =>
    h(
      "div",
      { className: cx("inline-flex shrink-0 rounded-md border border-border p-0.5", className) },
      (options || []).map((option) =>
        h(
          "button",
          {
            key: String(option.value),
            type: "button",
            title: option.title,
            onClick: () => onChange?.(option.value),
            className: cx(
              "rounded px-1.5 py-0.5 text-[11px] transition-colors",
              String(option.value) === String(value)
                ? "bg-accent-soft text-text"
                : "text-muted hover:text-text",
            ),
          },
          option.label,
        ),
      ),
    );

  const Field = ({ label, hint, children, className, wide }) =>
    h(
      "label",
      { className: cx("flex flex-col gap-1", wide && "col-span-2", className) },
      h("span", { className: LABEL_CLASS }, label),
      children,
      hint ? h("span", { className: "text-[10px] text-muted/80" }, hint) : null,
    );

  const Tabs = ({ items, value, onChange }) =>
    h(
      "div",
      { className: "flex min-w-0 items-center gap-0.5 overflow-x-auto", role: "tablist" },
      (items || []).map((item) =>
        h(
          "button",
          {
            key: item.id,
            type: "button",
            role: "tab",
            "aria-selected": item.id === value,
            title: item.title,
            onClick: () => onChange?.(item.id),
            className: cx(
              "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
              item.id === value
                ? "bg-accent-soft font-medium text-text"
                : "text-muted hover:bg-accent-soft/60 hover:text-text",
            ),
          },
          item.label,
          item.count === undefined || item.count === null
            ? null
            : h(
                "span",
                {
                  className: cx(
                    "rounded-full px-1 text-[10px] tabular-nums",
                    item.id === value ? "bg-panel/70 text-muted" : "text-muted/70",
                  ),
                },
                item.count,
              ),
        ),
      ),
    );

  const Toolbar = ({ children, className }) =>
    h(
      "div",
      {
        className: cx(
          "flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5",
          className,
        ),
      },
      children,
    );

  /** A flex spacer, so a toolbar can push its trailing actions to the right. */
  const Spacer = () => h("div", { className: "ml-auto" });

  return {
    Button,
    Checkbox,
    Dot,
    Field,
    Mono,
    Pill,
    Segmented,
    Select,
    Spacer,
    Spinner,
    Tabs,
    TextArea,
    TextInput,
    Toolbar,
  };
}
