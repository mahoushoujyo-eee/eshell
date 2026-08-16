const INDENT = "  ";

export function applyEditorTab(value, selectionStart, selectionEnd) {
  const text = String(value ?? "");
  const start = Number.isInteger(selectionStart) ? selectionStart : 0;
  const end = Number.isInteger(selectionEnd) ? selectionEnd : start;

  if (start === end) {
    return {
      value: `${text.slice(0, start)}${INDENT}${text.slice(end)}`,
      selectionStart: start + INDENT.length,
      selectionEnd: start + INDENT.length,
    };
  }

  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const indentEnd = text[end - 1] === "\n" ? end - 1 : end;
  const selected = text.slice(lineStart, indentEnd);
  const trailingBoundary = text.slice(indentEnd, end);
  const indented = selected.replace(/^/gm, INDENT);
  const valueNext = `${text.slice(0, lineStart)}${indented}${trailingBoundary}${text.slice(end)}`;
  const inserted = indented.length - selected.length;

  return {
    value: valueNext,
    selectionStart: start,
    selectionEnd: end + inserted,
  };
}
