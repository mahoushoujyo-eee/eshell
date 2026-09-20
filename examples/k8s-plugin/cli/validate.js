// Value validation for the kubectl command builders.
//
// Resource names come back from kubectl itself, but they still reach a command
// line. Everything here is refused unless it matches a charset that cannot
// carry shell syntax — no space, quote, `;`, `|`, `&`, `$`, backtick, glob,
// newline, or a leading `-` (which the CLI would read as a flag). Values that
// legitimately contain other characters (a kubeconfig context name, a label
// selector) are validated AND quoted.

import { assert, shellQuote } from "./shell.js";

/** An RFC 1123 name, plus the `:` that appears in some built-in RBAC names. */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,252}$/;
/** A namespace: RFC 1123 label. */
const SAFE_NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** A resource type: `pods`, `deploy`, `pods.v1.apps`, `crontabs.stable.example.com`. */
const SAFE_KIND = /^[a-zA-Z][a-zA-Z0-9.-]{0,62}$/;
/** A container name. */
const SAFE_CONTAINER = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/**
 * A kubeconfig context name. EKS/GKE contexts carry `/`, `@` and `:`
 * (`arn:aws:eks:eu-west-1:1234:cluster/prod`), so the charset is wider than a
 * resource name — and the value is quoted on the command line as well.
 */
const SAFE_CONTEXT = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,252}$/;
/** A label or field selector: `app=web,tier!=db`, `status.phase=Running`. */
const SAFE_SELECTOR = /^[a-zA-Z0-9][a-zA-Z0-9._/=!,()-]{0,252}$/;
/** A `--sort-by` JSONPath fragment. */
const SAFE_SORT_BY = /^\.[a-zA-Z0-9.[\]'"_-]{1,120}$/;
/** A `--since` duration, as Go parses it. */
const SAFE_DURATION = /^\d{1,6}(s|m|h)$/;
/** A port-forward mapping: `8080:80`, `8080`, `8080:http`. */
const SAFE_PORT_MAP = /^\d{1,5}(:([0-9]{1,5}|[a-z][a-z0-9-]{0,14}))?$/;

export const isSafeName = (value) => SAFE_NAME.test(String(value ?? ""));
export const isSafeNamespace = (value) => SAFE_NAMESPACE.test(String(value ?? ""));
export const isSafeKind = (value) => SAFE_KIND.test(String(value ?? ""));

const checked = (pattern, message) => (value) => {
  const text = String(value ?? "").trim();
  assert(pattern.test(text), message);
  return text;
};

export const resourceName = checked(SAFE_NAME, "refusing to address a resource by an unexpected name");
export const namespaceName = checked(SAFE_NAMESPACE, "not a valid namespace name");
export const containerName = checked(SAFE_CONTAINER, "not a valid container name");
export const selector = checked(SAFE_SELECTOR, "not a valid selector");
export const sortBy = checked(SAFE_SORT_BY, "not a valid --sort-by path");
export const duration = checked(SAFE_DURATION, "not a valid duration");
export const portMapping = checked(SAFE_PORT_MAP, "not a valid port mapping");

/** A resource type, lower-cased the way kubectl accepts it. */
export function kindName(value) {
  const text = String(value ?? "").trim();
  assert(SAFE_KIND.test(text), "not a valid resource type");
  return text;
}

/** A context name, validated and then quoted: the charset allows `/` and `@`. */
export function contextFlag(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }
  assert(SAFE_CONTEXT.test(text), "not a valid kubeconfig context name");
  return ["--context", shellQuote(text)];
}

/**
 * The namespace flags. `allNamespaces` wins, because `-A` and `-n` together are
 * a contradiction kubectl resolves silently.
 *
 * WHERE these end up matters. `--context` and `--namespace` are persistent flags
 * on kubectl's root command, but `-A` / `--all-namespaces` is local to the
 * subcommands that list things. A flag kubectl does not know at root level is
 * handed to its plugin resolver, which fails with
 * "flags cannot be placed before plugin name: -A" — so every builder in this
 * directory puts its flags AFTER the subcommand and its positional arguments,
 * which is valid for all of them.
 */
export function namespaceFlags({ namespace, allNamespaces, namespaced = true } = {}) {
  if (!namespaced) {
    return [];
  }
  if (allNamespaces) {
    return ["-A"];
  }
  const text = String(namespace ?? "").trim();
  return text ? ["-n", namespaceName(text)] : [];
}

/**
 * The scope flags for a LISTING (`get`, `get events`, `top pods`) — the only
 * commands that accept `-A`.
 */
export const listScope = (options = {}) => [
  contextFlag(options.context),
  namespaceFlags(options),
];

/**
 * The scope flags for a command that addresses ONE object (describe, logs,
 * exec, delete, scale, rollout, patch, apply…). `-A` is dropped: those
 * subcommands do not accept it, and "this object, in every namespace" is not a
 * thing. The panel supplies the row's own namespace instead (see
 * `client.withScope`).
 */
export const objectScope = (options = {}) => [
  contextFlag(options.context),
  namespaceFlags({ ...options, allNamespaces: false }),
];

/** `<kind>/<name>`, the form every single-object verb takes. */
export function target(kind, name) {
  return `${kindName(kind)}/${resourceName(name)}`;
}
