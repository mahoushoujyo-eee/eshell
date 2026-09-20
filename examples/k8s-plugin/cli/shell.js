// Command-line plumbing shared by every kubectl command builder.
//
// Two rules hold for the whole `cli/` directory:
//
//  1. A verb is never taken from user input — it comes from a closed set.
//  2. Every value that reaches the command line is either validated against a
//     charset that cannot carry shell syntax (`validate.js`) or single-quoted
//     with `shellQuote`. Free-form text is tokenised and re-quoted token by
//     token rather than pasted in raw.

export const DEFAULT_BIN = "kubectl";

// The user-facing CLI prefix: `kubectl`, `k3s kubectl`, `microk8s kubectl`,
// `sudo -n kubectl`, or an absolute path. `sudo -n` matters — a plain `sudo`
// would block on a password prompt that a non-interactive exec channel can
// never answer.
const SAFE_BIN = /^[A-Za-z0-9_/][A-Za-z0-9 _./:=-]*$/;

/** Normalises a user-supplied CLI prefix, falling back to `kubectl`. */
export function sanitizeBin(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) {
    return DEFAULT_BIN;
  }
  return SAFE_BIN.test(text) ? text : DEFAULT_BIN;
}

/**
 * POSIX single-quoting: the only quoting form with no escapes inside it, so
 * every byte except `'` passes through untouched. Used for paths and values
 * that legitimately contain spaces.
 */
export const shellQuote = (value) => `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;

/**
 * A heredoc, for the one command that takes a document on stdin
 * (`kubectl apply -f -`). The delimiter is quoted, so the shell performs no
 * expansion on the body; the caller must check that no line of the body is the
 * delimiter itself.
 */
export const heredoc = (command, body, delimiter) =>
  `${command} <<'${delimiter}'\n${body}\n${delimiter}`;

/** Joins a command from a prefix plus parts, dropping empty ones. */
export const cli = (options, ...parts) =>
  [sanitizeBin(options?.bin), ...parts.flat(2)]
    .filter((part) => part !== null && part !== undefined && part !== false && part !== "")
    .join(" ");

/** `when(cond, "-f")` — an empty list when the flag does not apply. */
export const when = (condition, ...parts) => (condition ? parts : []);

export const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

export const positiveInt = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
};

/**
 * Splits a command line into argv the way a shell would for quotes and
 * whitespace, so each token can be re-quoted individually. Backslash escapes
 * are deliberately not interpreted — a lone `\` stays a literal character,
 * which keeps a Windows-style path inside a quoted token intact.
 */
export function tokenizeArgs(text) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;
  for (const char of String(text ?? "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  assert(!quote, "unbalanced quote in the command line");
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Tokenises a command line and re-quotes every token. */
export const quoteCommandLine = (text) => tokenizeArgs(text).map(shellQuote).join(" ");
