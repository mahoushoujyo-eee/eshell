// The resource table.
//
// Columns come from kubectl, not from this file: whatever `-o wide` printed for
// the selected type is what is rendered, so a CRD with server-defined columns
// works the same as `pods`. The only additions are the leading health dot, the
// tone on cells whose text has a meaning (`parse/status.js`), and the action
// column.

import { cellTone, displayCell, rowTone } from "../parse/status.js";
import { columnWidth } from "./format.js";

const TONE_CLASS = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-muted",
};

export function createResourceTable({ h, ui, t, rowActions }) {
  const { Button, DataTable, Dot, EmptyState } = ui;

  const cell = (column, row) => {
    const value = row.byName[column];
    const tone = cellTone(column, value);
    return h(
      "span",
      {
        className: tone ? `truncate ${TONE_CLASS[tone]}` : "truncate",
        title: value,
      },
      displayCell(value),
    );
  };

  const firstCell = (column, row) =>
    h(
      "div",
      { className: "flex min-w-0 items-center gap-1.5" },
      h(Dot, { tone: rowTone(row), title: row.byName.STATUS || row.byName.READY || "" }),
      h(
        "span",
        { className: "truncate font-medium", title: row.byName[column] },
        displayCell(row.byName[column]),
      ),
    );

  const columnsFor = (c) => {
    const columns = c.columns.map((column, index) => ({
      key: `${column}-${index}`,
      label: column,
      width: columnWidth(column, index),
      render: (row) => (index === 0 ? firstCell(column, row) : cell(column, row)),
    }));
    columns.push({
      key: "__actions",
      label: "",
      width: "128px",
      render: (row) => rowActions(c, row),
    });
    return columns;
  };

  /** Appears only when rows are ticked. Delete is the one bulk verb offered. */
  const SelectionBar = ({ c }) => {
    if (c.selection.size === 0) {
      return null;
    }
    const rows = c.selectedRows;
    const names = rows.map((row) => row.name);
    return h(
      "div",
      {
        className:
          "flex shrink-0 items-center gap-1.5 border-b border-border bg-accent-soft/40 px-3 py-1.5 text-[11px]",
      },
      h("span", { className: "font-medium" }, t("{count} selected", { count: rows.length })),
      c.descriptor.noDelete
        ? h("span", { className: "text-muted" }, t("This type cannot be deleted from here."))
        : h(Button, {
            label: t("Delete selected"),
            size: "xs",
            tone: "danger",
            title: `kubectl delete ${c.descriptor.kind} ${names.slice(0, 3).join(" ")}${
              names.length > 3 ? " …" : ""
            }`,
            onClick: () =>
              c.askConfirm({
                title: t("Delete {count} objects?", { count: rows.length }),
                body: t("There is no undo. A controller may recreate them immediately."),
                command: `kubectl delete ${c.descriptor.kind} ${names.join(" ")}`,
                confirmLabel: t("Delete"),
                tone: "danger",
                run: () =>
                  c.bulkTask(`kubectl delete ${c.descriptor.kind}`, rows, (row) =>
                    c.clientFor(row).remove(c.descriptor.kind, row.name),
                  ),
              }),
          }),
      h(Button, { label: t("Clear"), size: "xs", tone: "ghost", onClick: c.clearSelection }),
    );
  };

  const ResourceTable = ({ c }) =>
    h(DataTable, {
      columns: columnsFor(c),
      rows: c.rows,
      rowKey: (row) => row.key,
      selectable: !c.descriptor.noDelete,
      selected: c.selection,
      onToggleSelect: c.toggleSelect,
      onToggleAll: (on) => c.toggleSelectAll(on, c.rows.map((row) => row.key)),
      empty: h(EmptyState, {
        title: c.loading
          ? t("Loading…")
          : c.note || t("No {kind} found.", { kind: c.descriptor.label }),
        description: c.loading
          ? ""
          : c.query || c.onlyProblems
            ? t("The filter matched nothing in this listing.")
            : t("kubectl get {kind} returned an empty list for this scope.", {
                kind: c.descriptor.kind,
              }),
      }),
    });

  return { ResourceTable, SelectionBar };
}
