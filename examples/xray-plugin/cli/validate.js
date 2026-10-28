// Value validation for the command builders.
//
// Everything that reaches a command line comes through here first. The paths
// are held to a deliberately narrow charset — no spaces, no quotes, no `$`,
// no backticks — because the config write runs inside an `sh -c` script where
// the path sits inside double quotes. A path that cannot be expressed in
// that charset is refused rather than quoted and hoped for.
//
// The tags follow Xray's own rules: an outbound tag and a balancer tag are
// short identifiers, and the plugin derives node tags from a prefix, so the
// prefix charset has to stay inside what Xray accepts as a tag.

import { assert } from "./shell.js";

/** An outbound or balancer tag. */
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** The tag prefix a subscription stamps onto the nodes it owns. */
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** An absolute path with no whitespace and no shell-active characters. */
const SAFE_PATH = /^\/[A-Za-z0-9._/@:+-]{1,240}$/;
/** A systemd unit name. */
const SAFE_UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
/** An absolute path to an executable, or a bare command name. */
const SAFE_BIN_PATH = /^(?:\/[A-Za-z0-9._/@:+-]{1,240}|[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/;
/** An http(s) URL with no whitespace and no quote characters. */
const SAFE_URL = /^https?:\/\/[^\s"'`\\]{1,2000}$/;

export const isSafeTag = (value) => SAFE_TAG.test(String(value ?? ""));
export const isSafePrefix = (value) => SAFE_PREFIX.test(String(value ?? ""));
export const isSafeUrl = (value) => SAFE_URL.test(String(value ?? ""));
export const isSafePath = (value) => SAFE_PATH.test(String(value ?? ""));
export const isSafeUnit = (value) => SAFE_UNIT.test(String(value ?? ""));
export const isSafeBinPath = (value) => SAFE_BIN_PATH.test(String(value ?? ""));

const checked = (pattern, message) => (value) => {
  const text = String(value ?? "").trim();
  assert(pattern.test(text), message);
  return text;
};

/** An outbound / balancer tag. */
export const tagName = checked(SAFE_TAG, "not a valid tag");
/** The prefix a subscription stamps onto its nodes. */
export const prefixName = checked(SAFE_PREFIX, "not a valid tag prefix");
/** An absolute config path. */
export const configPath = checked(
  SAFE_PATH,
  "the path cannot be used safely: only letters, digits, dot, dash, slash, @, colon and plus are allowed",
);
/** A systemd unit. */
export const serviceUnit = checked(SAFE_UNIT, "not a valid service name");
/** An absolute path to the xray binary, or a bare command name. */
export const binaryPath = checked(SAFE_BIN_PATH, "not a valid binary path");

/** The balancer strategies Xray ships. */
export const STRATEGIES = ["random", "roundRobin", "leastPing", "leastLoad"];

/** A strategy name, from the closed set Xray accepts. */
export function strategyType(value) {
  const text = String(value ?? "").trim();
  assert(STRATEGIES.includes(text), "not a valid balancer strategy");
  return text;
}
