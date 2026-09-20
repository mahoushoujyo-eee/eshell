// Overlays and messaging: the dropdown menu, the full-panel sheet, the centred
// modal, the notice bar and the empty state.

import { BUTTON_TONES, SIZES, TONE_TEXT, cx } from "./tokens.js";

export function createOverlays(react, controls) {
  const { createElement: h, useEffect, useRef, useState } = react;
  const { Button, Mono, Spinner } = controls;

  const EmptyState = ({ title, description, action }) =>
    h(
      "div",
      { className: "flex h-full flex-col items-center justify-center gap-2 p-6 text-center" },
      h("p", { className: "text-xs font-medium text-text" }, title),
      description ? h("p", { className: "max-w-sm text-[11px] text-muted" }, description) : null,
      action || null,
    );

  const NoticeBar = ({ notice, onDismiss }) =>
    notice
      ? h(
          "div",
          {
            role: "status",
            className: cx(
              "flex shrink-0 items-start gap-2 border-b border-border px-3 py-1.5 text-[11px]",
              TONE_TEXT[notice.tone] || TONE_TEXT.neutral,
            ),
          },
          notice.busy ? h(Spinner, { key: "busy", className: "mt-0.5" }) : null,
          h("span", { className: "min-w-0 flex-1 break-words" }, notice.text),
          notice.command
            ? h(
                Mono,
                { className: "max-w-[40%] shrink-0 truncate text-muted", title: notice.command },
                notice.command,
              )
            : null,
          onDismiss
            ? h(
                "button",
                {
                  type: "button",
                  className: "shrink-0 text-muted hover:text-text",
                  onClick: onDismiss,
                  "aria-label": "Dismiss",
                },
                "×",
              )
            : null,
        )
      : null;

  /**
   * A dropdown anchored with fixed coordinates rather than `absolute`, because
   * rows live inside a scrolling list: an absolutely positioned menu on the
   * last row would be clipped by the list's own overflow.
   */
  const Menu = ({ label = "⋯", items, disabled, title, tone = "ghost", size = "xs" }) => {
    const [anchor, setAnchor] = useState(null);
    const buttonRef = useRef(null);
    const visible = (items || []).filter(Boolean);

    useEffect(() => {
      if (!anchor) {
        return undefined;
      }
      const close = () => setAnchor(null);
      const onKey = (event) => {
        if (event.key === "Escape") {
          close();
        }
      };
      window.addEventListener("mousedown", close);
      window.addEventListener("resize", close);
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("mousedown", close);
        window.removeEventListener("resize", close);
        window.removeEventListener("keydown", onKey);
      };
    }, [anchor]);

    const open = (event) => {
      event.stopPropagation();
      if (anchor) {
        setAnchor(null);
        return;
      }
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const width = 210;
      const height = Math.min(visible.length * 26 + 8, 320);
      const below = window.innerHeight - rect.bottom > height + 8;
      setAnchor({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: below ? rect.bottom + 4 : Math.max(8, rect.top - height - 4),
        width,
        maxHeight: height,
      });
    };

    return h(
      "div",
      { className: "relative shrink-0" },
      h(
        "button",
        {
          ref: buttonRef,
          type: "button",
          title: title || "More actions",
          "aria-haspopup": "menu",
          "aria-expanded": Boolean(anchor),
          disabled: disabled || visible.length === 0,
          onClick: open,
          className: cx(
            "inline-flex items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            BUTTON_TONES[tone] || BUTTON_TONES.ghost,
            SIZES[size] || SIZES.xs,
          ),
        },
        label,
      ),
      anchor
        ? h(
            "div",
            {
              role: "menu",
              onMouseDown: (event) => event.stopPropagation(),
              style: {
                position: "fixed",
                left: `${anchor.left}px`,
                top: `${anchor.top}px`,
                width: `${anchor.width}px`,
                maxHeight: `${anchor.maxHeight}px`,
              },
              className: "z-50 overflow-auto rounded-lg border border-border bg-panel py-1 shadow-lg",
            },
            visible.map((item, index) =>
              item.separator
                ? h("div", { key: `sep-${index}`, className: "my-1 border-t border-border" })
                : h(
                    "button",
                    {
                      key: item.key || item.label,
                      type: "button",
                      role: "menuitem",
                      disabled: item.disabled,
                      title: item.title,
                      onClick: () => {
                        setAnchor(null);
                        item.onClick?.();
                      },
                      className: cx(
                        "flex w-full items-center justify-between gap-2 px-2.5 py-1 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                        item.tone === "danger"
                          ? "text-danger hover:bg-danger/10"
                          : "text-text hover:bg-accent-soft",
                      ),
                    },
                    h("span", { className: "truncate" }, item.label),
                    item.hint
                      ? h("span", { className: "shrink-0 text-[10px] text-muted" }, item.hint)
                      : null,
                  ),
            ),
          )
        : null,
    );
  };

  const useEscape = (onClose) => {
    useEffect(() => {
      const onKey = (event) => {
        if (event.key === "Escape") {
          onClose?.();
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
  };

  /** A full-panel sheet: used for logs, inspect output and long text. */
  const Sheet = ({ title, subtitle, actions, tabs, children, onClose, footer }) => {
    useEscape(onClose);
    return h(
      "div",
      {
        role: "dialog",
        "aria-label": typeof title === "string" ? title : undefined,
        className: "absolute inset-0 z-20 flex flex-col bg-panel",
      },
      h(
        "div",
        { className: "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2" },
        h(
          "div",
          { className: "flex min-w-0 flex-1 flex-col" },
          h("span", { className: "truncate text-xs font-semibold text-text" }, title),
          subtitle ? h("span", { className: "truncate text-[10px] text-muted" }, subtitle) : null,
        ),
        h(
          "div",
          { className: "flex shrink-0 items-center gap-1.5" },
          actions,
          h(Button, { key: "close", label: "Close", size: "xs", onClick: onClose, title: "Close (Esc)" }),
        ),
      ),
      tabs ? h("div", { className: "shrink-0 border-b border-border px-3 py-1" }, tabs) : null,
      children,
      footer || null,
    );
  };

  /** A centred dialog for forms and confirmations. */
  const Modal = ({ title, description, children, actions, onClose, width = "max-w-xl" }) => {
    useEscape(onClose);
    return h(
      "div",
      {
        className: "absolute inset-0 z-30 flex items-center justify-center bg-bg/60 p-4",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) {
            onClose?.();
          }
        },
      },
      h(
        "div",
        {
          role: "dialog",
          "aria-modal": "true",
          "aria-label": typeof title === "string" ? title : undefined,
          className: cx(
            "flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-lg",
            width,
          ),
        },
        h(
          "div",
          { className: "shrink-0 border-b border-border px-4 py-2.5" },
          h("p", { className: "text-xs font-semibold text-text" }, title),
          description ? h("p", { className: "mt-0.5 text-[11px] text-muted" }, description) : null,
        ),
        h("div", { className: "min-h-0 flex-1 overflow-auto px-4 py-3" }, children),
        actions
          ? h(
              "div",
              {
                className:
                  "flex shrink-0 items-center justify-end gap-1.5 border-t border-border px-4 py-2",
              },
              actions,
            )
          : null,
      ),
    );
  };

  return { EmptyState, Menu, Modal, NoticeBar, Sheet };
}
