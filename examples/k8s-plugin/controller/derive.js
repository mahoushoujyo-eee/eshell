// Pure derivations over a parsed kubectl table: which columns to show, which
// rows match the filter, and the health summary above the list.

import { cellTone, isNoisyColumn, rowTone } from "../parse/status.js";

/**
 * The columns worth rendering. `-o wide` adds several that are almost always
 * `<none>` (NOMINATED NODE, READINESS GATES); they are dropped by default and a
 * toggle brings them back rather than being removed outright.
 */
export function visibleColumns(columns, { hideNoisy }) {
  if (!hideNoisy) {
    return columns;
  }
  return columns.filter((column) => !isNoisyColumn(column));
}

/** A substring match over every cell of a row. */
export function filterRows(rows, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter((row) =>
    row.cells.some((cell) => String(cell ?? "").toLowerCase().includes(needle)),
  );
}

/**
 * How many rows are healthy, busy or broken — the same opinion the row dots
 * show, counted for the summary chips.
 */
export function summarise(rows) {
  const summary = { total: rows.length, success: 0, warning: 0, danger: 0 };
  for (const row of rows) {
    const tone = rowTone(row);
    if (tone === "success" || tone === "warning" || tone === "danger") {
      summary[tone] += 1;
    }
  }
  return summary;
}

/** True when a row is not in a healthy state, for the "only problems" filter. */
export const isUnhealthy = (row) => {
  const tone = rowTone(row);
  return tone === "danger" || tone === "warning";
};

/** The cell tone lookup the table renderer uses, bound to one column list. */
export const toneFor = (column, value) => cellTone(column, value);
