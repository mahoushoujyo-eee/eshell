import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The broker is gated twice: the JS bridge refuses a command the facade is not
// allowed to broker (`src/lib/plugin-host.js`), and the Rust dispatcher refuses
// one that is not on its whitelist (`src-tauri/src/domain/extensions/consts.rs`).
// A command present in one and missing from the other fails at runtime with a
// message that names neither file — which is exactly what happened when
// `list_port_forwards` shipped with only the Rust half.
//
// This test reads both sources and fails on drift. It is a text scan rather
// than an import because the Rust side is not importable from JS; the shapes
// it parses are stable enough that a rename would be a compile error on the
// Rust side anyway.
const readSource = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

/**
 * Every quoted command name inside the array literal that follows
 * `startMarker`. The list is delimited by matching brackets rather than a
 * literal `];`, because the JS side closes `new Set([...])` and the Rust side
 * closes a `&[&str]` — only the bracket is common to both.
 *
 * The opening bracket is searched for *after* the `=`, because a Rust
 * declaration spells the element type first (`&[&str] = &[...]`) and the type
 * brackets would otherwise be mistaken for an empty list.
 */
const quotedNamesIn = (source, startMarker) => {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`marker not found: ${startMarker}`);
  }
  const equals = source.indexOf("=", start);
  if (equals < 0) {
    throw new Error(`no assignment after: ${startMarker}`);
  }
  const open = source.indexOf("[", equals);
  if (open < 0) {
    throw new Error(`no array literal after: ${startMarker}`);
  }
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "[") {
      depth += 1;
    } else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) {
    throw new Error(`unterminated list after: ${startMarker}`);
  }
  return new Set(
    [...source.slice(open, close).matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]),
  );
};

describe("extension broker whitelists", () => {
  const jsCommands = quotedNamesIn(
    readSource("../../lib/plugin-host.js"),
    "const BROKERED_COMMANDS = new Set(",
  );
  const rustCommands = quotedNamesIn(
    readSource("../../../src-tauri/src/domain/extensions/consts.rs"),
    "pub(crate) const WHITELIST: &[&str] = &[",
  );

  it("parses a non-trivial list from each side", () => {
    // Guards the parser itself: a refactor that emptied either list would
    // otherwise make the parity assertion below vacuously true.
    expect(jsCommands.size).toBeGreaterThan(10);
    expect(rustCommands.size).toBeGreaterThan(10);
  });

  // Backend commands the facade deliberately does not expose. The legacy
  // base64 download endpoint is kept brokerable for wire compatibility but has
  // no facade method, so the asymmetry is one-directional and intentional.
  // Anything else appearing here is drift, not a decision.
  const BACKEND_ONLY = new Set(["sftp_download_file"]);

  it("brokers nothing the backend refuses", () => {
    // The direction that matters: a facade method whose command the backend
    // does not whitelist fails at runtime with a message naming neither file.
    const onlyJs = [...jsCommands].filter((name) => !rustCommands.has(name)).sort();
    expect(onlyJs).toEqual([]);
  });

  it("exposes every backend command except the documented exceptions", () => {
    const onlyRust = [...rustCommands]
      .filter((name) => !jsCommands.has(name) && !BACKEND_ONLY.has(name))
      .sort();
    expect(onlyRust).toEqual([]);
  });
});
