// The kubectl table reader.
//
// Every listing goes through `kubectl get -o wide`, and this turns its output
// into rows. That is what lets the panel show ANY resource type — including a
// CRD whose columns the API server decides — with the same code, and it is the
// same view the user sees in a terminal.
//
// Why column offsets rather than splitting on whitespace: kubectl pads every
// column to its widest value, so a header name's position is the column's start
// in every row. Values legitimately contain single spaces (`3 (5m ago)` in
// RESTARTS, `Ready,SchedulingDisabled` is one token but `NOMINATED NODE` is a
// two-word HEADER), which whitespace splitting would tear apart.

const splitLines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");

/**
 * Reads a kubectl table into `{ columns, rows }`. Each row carries its cells in
 * order plus a name→value map, so a renderer can look up "STATUS" without
 * knowing which position it is in for this resource type.
 *
 * Only call this on the stdout of a command that exited 0: kubectl writes
 * "No resources found" to stderr, so an empty stdout means an empty list.
 */
export function parseTable(text) {
  const lines = splitLines(text);
  if (lines.length === 0) {
    return { columns: [], rows: [] };
  }
  const header = lines[0];
  // Two or more spaces separate columns; one space can be inside a header name
  // ("NOMINATED NODE", "READINESS GATES").
  const columns = header.trim().split(/\s{2,}/);
  const offsets = [];
  let cursor = 0;
  for (const name of columns) {
    const index = header.indexOf(name, cursor);
    if (index < 0) {
      return { columns: [], rows: [] };
    }
    offsets.push(index);
    cursor = index + name.length;
  }

  const rows = lines.slice(1).map((line, index) => {
    const cells = offsets.map((start, position) => {
      const end = position + 1 < offsets.length ? offsets[position + 1] : line.length;
      return line.slice(start, end).trim();
    });
    const byName = {};
    columns.forEach((name, position) => {
      byName[name] = cells[position] ?? "";
    });
    return {
      cells,
      byName,
      name: byName.NAME || cells[columns[0] === "NAMESPACE" ? 1 : 0] || "",
      namespace: byName.NAMESPACE || "",
      // Unique within one listing: a name can repeat across namespaces, and a
      // resource type without a NAME column (rare, but `kubectl top` prints
      // one) still needs a stable key.
      key: `${byName.NAMESPACE || ""}/${byName.NAME || cells.join("|")}#${index}`,
    };
  });

  return { columns, rows };
}

/** `-o name` output: `namespace/default`, `pod/web-1` → the bare names. */
export const parseNameList = (text) =>
  splitLines(text).map((line) => {
    const trimmed = line.trim();
    const slash = trimmed.indexOf("/");
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  });

/** `config get-contexts -o name`: one context per line, unsorted. */
export const parseContexts = (text) =>
  splitLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

/** The pod container list from the tagged jsonpath template. */
export function parseContainers(text) {
  return splitLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [kind, ...rest] = line.split("/");
      const name = rest.join("/");
      return { name: name || kind, init: kind === "init" };
    })
    .filter((entry) => entry.name);
}

/**
 * `kubectl version -o json`. Both halves are optional: the client version is
 * printed even when the API server is unreachable.
 */
export function parseVersion(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") {
    return null;
  }
  const client = data.clientVersion || {};
  const server = data.serverVersion || null;
  return {
    clientVersion: String(client.gitVersion || ""),
    serverVersion: String((server && server.gitVersion) || ""),
    platform: String(client.platform || ""),
    live: Boolean(server && server.gitVersion),
  };
}
