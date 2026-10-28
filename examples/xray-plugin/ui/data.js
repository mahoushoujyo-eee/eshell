// Data display: the table, key/value lists, stat tiles, meters and the text
// viewers used by the log and output sheets.

import { LABEL_CLASS, TONE_TEXT, cx } from "./tokens.js";

export function createData(react, controls) {
  const { createElement: h, useEffect, useMemo, useRef, useState } = react;
  const { Button } = controls;

  /**
   * A table with a sticky header. Columns are `{ key, label, width, align,
   * render(row), title }`; `width` is a CSS grid track, so every row aligns
   * without measuring anything.
   */
  const DataTable = ({
    columns,
    rows,
    rowKey,
    onRowClick,
    activeKey,
    selectable,
    selected,
    onToggleSelect,
    onToggleAll,
    empty,
    dense,
  }) => {
    const template = [
      selectable ? "24px" : null,
      ...columns.map((column) => column.width || "minmax(0,1fr)"),
    ]
      .filter(Boolean)
      .join(" ");
    const allSelected =
      selectable && rows.length > 0 && rows.every((row, index) => selected?.has(rowKey(row, index)));

    return h(
      "div",
      { className: "flex min-h-0 flex-1 flex-col" },
      h(
        "div",
        {
          className:
            "grid shrink-0 items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-[10px] font-semibold tracking-[0.12em] text-muted uppercase",
          style: { gridTemplateColumns: template },
        },
        selectable
          ? h("input", {
              key: "all",
              type: "checkbox",
              checked: Boolean(allSelected),
              onChange: (event) => onToggleAll?.(event.target.checked),
              "aria-label": "Select all",
              className: "h-3 w-3",
            })
          : null,
        columns.map((column) =>
          h(
            "span",
            {
              key: column.key,
              className: cx("truncate", column.align === "right" && "text-right"),
              title: column.title,
            },
            column.label,
          ),
        ),
      ),
      rows.length === 0
        ? h("div", { className: "flex-1 overflow-auto" }, empty)
        : h(
            "div",
            { className: "min-h-0 flex-1 overflow-auto" },
            rows.map((row, index) => {
              const key = rowKey(row, index);
              return h(
                "div",
                {
                  key,
                  onClick: onRowClick ? () => onRowClick(row) : undefined,
                  className: cx(
                    "grid items-center gap-2 border-b border-border/50 px-3 text-[11px] transition-colors",
                    dense ? "py-1" : "py-1.5",
                    onRowClick && "cursor-pointer",
                    activeKey === key ? "bg-accent-soft/60" : "hover:bg-accent-soft/30",
                  ),
                  style: { gridTemplateColumns: template },
                },
                selectable
                  ? h("input", {
                      type: "checkbox",
                      checked: Boolean(selected?.has(key)),
                      onClick: (event) => event.stopPropagation(),
                      onChange: () => onToggleSelect?.(key),
                      "aria-label": `Select ${key}`,
                      className: "h-3 w-3",
                    })
                  : null,
                columns.map((column) =>
                  h(
                    "div",
                    {
                      key: column.key,
                      className: cx(
                        "min-w-0 truncate",
                        column.align === "right" && "text-right",
                        column.className,
                      ),
                    },
                    column.render(row),
                  ),
                ),
              );
            }),
          ),
    );
  };

  const KeyValue = ({ rows, columns = 1 }) =>
    h(
      "div",
      { className: cx("grid gap-x-4 gap-y-1", columns === 2 ? "sm:grid-cols-2" : "grid-cols-1") },
      (rows || [])
        .filter((row) => row && row.value !== undefined && row.value !== null && row.value !== "")
        .map((row) =>
          h(
            "div",
            { key: row.label, className: "flex min-w-0 gap-2 text-[11px]" },
            h("span", { className: "w-28 shrink-0 text-muted" }, row.label),
            h(
              "span",
              {
                className: cx("min-w-0 flex-1 break-words", row.mono && "font-mono text-[10px]"),
                title: typeof row.value === "string" ? row.value : undefined,
              },
              row.value,
            ),
          ),
        ),
    );

  const StatTile = ({ label, value, hint, tone }) =>
    h(
      "div",
      { className: "rounded-lg border border-border bg-surface/40 px-3 py-2" },
      h("p", { className: LABEL_CLASS }, label),
      h(
        "p",
        { className: cx("mt-0.5 truncate text-sm font-semibold tabular-nums", TONE_TEXT[tone]) },
        value,
      ),
      hint ? h("p", { className: "truncate text-[10px] text-muted" }, hint) : null,
    );

  const Meter = ({ percent, tone = "bg-accent", label }) => {
    const safe = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
    return h(
      "div",
      { className: "flex min-w-0 items-center gap-1.5" },
      h(
        "div",
        { className: "h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-warm" },
        safe === null
          ? null
          : h("div", { className: cx("h-full rounded-full", tone), style: { width: `${safe}%` } }),
      ),
      label ? h("span", { className: "shrink-0 tabular-nums text-muted" }, label) : null,
    );
  };

  const CodeBlock = ({ text, wrap = true, className, emptyLabel = "(no output)", scrollRef }) =>
    h(
      "pre",
      {
        ref: scrollRef,
        className: cx(
          "min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-text",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          className,
        ),
      },
      text && text.trim() !== "" ? text : emptyLabel,
    );

  const CopyButton = ({ value, label = "Copy", copiedLabel = "Copied", title }) => {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
      if (!copied) {
        return undefined;
      }
      const timer = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(timer);
    }, [copied]);
    return h(Button, {
      label: copied ? copiedLabel : label,
      size: "xs",
      title: title || label,
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(String(value ?? ""));
          setCopied(true);
        } catch {
          // Clipboard access can be refused; the button simply does not flip.
        }
      },
    });
  };

  /**
   * A scrollable text viewer with a line filter. `stick` pins the view to the
   * bottom as new content arrives, which is what a log tail needs.
   */
  const TextViewer = ({ text, filter, wrap, stick }) => {
    const scrollRef = useRef(null);
    const filtered = useMemo(() => {
      const needle = String(filter ?? "").trim().toLowerCase();
      if (!needle) {
        return text;
      }
      return String(text ?? "")
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .join("\n");
    }, [text, filter]);

    useEffect(() => {
      if (stick && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [filtered, stick]);

    return h(CodeBlock, {
      text: filtered,
      wrap,
      scrollRef,
      emptyLabel: filter ? "(no matching lines)" : "(no output)",
    });
  };

  return { CodeBlock, CopyButton, DataTable, KeyValue, Meter, StatTile, TextViewer };
}
