// Command-line plumbing shared by every command builder.
//
// Two rules hold for the whole `cli/` directory:
//
//  1. A verb is never taken from user input — it comes from a closed set.
//  2. Every value that reaches the command line is either validated against a
//     charset that cannot carry shell syntax (`validate.js`) or single-quoted
//     with `shellQuote`. Free-form text is never pasted in raw.
//
// The one exception is the small `sh -c` script used for the config write,
// which carries the paths inside double quotes. That script is assembled from
// validated values only, and the validator refuses any path that could close
// a quote or start a substitution.

/**
 * POSIX single-quoting: the only quoting form with no escapes inside it, so
 * every byte except `'` passes through untouched. Used for paths and values
 * that legitimately contain spaces.
 */
export const shellQuote = (value) => `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;

/**
 * A heredoc, for the command that takes a document on stdin (writing the
 * config file). The delimiter is quoted, so the shell performs no expansion
 * on the body; the caller must check that no line of the body is the
 * delimiter itself.
 */
export const heredoc = (command, body, delimiter) =>
  `${command} <<'${delimiter}'\n${body}\n${delimiter}`;

export const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

/**
 * The privilege prefix: the empty string, or `sudo -n` with an optional
 * `-u <user>`. `sudo -n` never prompts — on a host where the SSH user may not
 * use sudo it fails immediately instead of hanging the exec channel.
 */
const SAFE_PRIVILEGE = /^sudo -n( -u [a-z_][a-z0-9_-]{0,31})?$/;

export function sanitizePrivilege(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) {
    return "";
  }
  return SAFE_PRIVILEGE.test(text) ? text : "";
}

/** Prefixes a command with the privilege escalation, when one is configured. */
export const withPrivilege = (command, privilege) => {
  const prefix = sanitizePrivilege(privilege);
  return prefix ? `${prefix} ${command}` : command;
};
