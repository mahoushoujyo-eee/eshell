// The commands that carry a payload or a stream: logs, exec, apply, and the
// port-forward line the panel can only hand to the user.

import { assert, cli, heredoc, positiveInt, shellQuote, tokenizeArgs } from "./shell.js";
import {
  containerName,
  duration,
  kindName,
  objectScope,
  portMapping,
  resourceName,
} from "./validate.js";

/**
 * `kubectl logs`. stderr is folded into stdout on the remote side: the two
 * streams arrive as separate strings over the exec channel, which loses their
 * interleaving, and kubectl's own diagnostics belong next to the output they
 * explain.
 */
export function logsCommand(pod, logOptions = {}, options = {}) {
  const extras = [`--tail=${positiveInt(logOptions.tail, 200)}`];
  if (logOptions.allContainers) {
    extras.push("--all-containers");
  } else if (logOptions.container) {
    extras.push("-c", containerName(logOptions.container));
  }
  if (logOptions.since) {
    extras.push(`--since=${duration(logOptions.since)}`);
  }
  if (logOptions.timestamps) {
    extras.push("--timestamps");
  }
  if (logOptions.previous) {
    extras.push("--previous");
  }
  if (logOptions.prefix) {
    extras.push("--prefix");
  }
  return `${cli(options, "logs", `pod/${resourceName(pod)}`, objectScope(options), extras)} 2>&1`;
}

/** Logs for every pod behind a workload — `kubectl logs deployment/x`. */
export function workloadLogsCommand(kind, name, logOptions = {}, options = {}) {
  const extras = [`--tail=${positiveInt(logOptions.tail, 200)}`, "--all-containers", "--prefix"];
  if (logOptions.since) {
    extras.push(`--since=${duration(logOptions.since)}`);
  }
  if (logOptions.timestamps) {
    extras.push("--timestamps");
  }
  return `${cli(
    options,
    "logs",
    `${kindName(kind)}/${resourceName(name)}`,
    objectScope(options),
    extras,
  )} 2>&1`;
}

/**
 * `kubectl exec` without a TTY — the exec channel is not interactive, so `-it`
 * would hang. `shell: true` wraps the line in `sh -c` (pipes and redirections
 * work, one quoted argument); otherwise the line is tokenised into argv, which
 * is what the CLI itself does after `--`.
 */
export function execCommand(pod, commandLine, execOptions = {}, options = {}) {
  const line = String(commandLine ?? "").trim();
  assert(line !== "", "an exec command is required");
  const extras = [];
  if (execOptions.container) {
    extras.push("-c", containerName(execOptions.container));
  }
  const argv = execOptions.shell
    ? ["sh", "-c", shellQuote(line)]
    : tokenizeArgs(line).map(shellQuote);
  assert(argv.length > 0, "an exec command is required");
  return `${cli(
    options,
    "exec",
    `pod/${resourceName(pod)}`,
    objectScope(options),
    extras,
    "--",
    argv,
  )} 2>&1`;
}

const APPLY_DELIMITER = "ESHELL_K8S_MANIFEST";

/**
 * `kubectl apply -f -`, with the manifest on stdin through a quoted heredoc: no
 * expansion happens inside the body, and nothing is written to the remote disk.
 * The one thing that could break out is a line equal to the delimiter, so that
 * is checked rather than escaped.
 *
 * `--prune` is deliberately never passed: it deletes objects that are merely
 * absent from the pasted document, which is not what "apply this" should mean
 * from a text box.
 */
export function applyCommand(manifest, applyOptions = {}, options = {}) {
  const body = String(manifest ?? "").replace(/\r\n/g, "\n").trimEnd();
  assert(body.trim() !== "", "the manifest is empty");
  assert(
    !body.split("\n").some((line) => line.trim() === APPLY_DELIMITER),
    `the manifest must not contain a line equal to ${APPLY_DELIMITER}`,
  );
  const extras = ["-f", "-"];
  if (applyOptions.dryRun) {
    extras.push("--dry-run=server");
  }
  return heredoc(cli(options, "apply", objectScope(options), extras), body, APPLY_DELIMITER);
}

/** `kubectl apply -f <path>` against a file already on the host. */
export const applyFileCommand = (path, applyOptions = {}, options = {}) =>
  cli(
    options,
    "apply",
    "-f",
    shellQuote(path),
    objectScope(options),
    applyOptions.dryRun ? "--dry-run=server" : "",
  );

/**
 * The port-forward command line. It is never executed here: it blocks until
 * interrupted, and an exec channel has no way to interrupt it. The panel shows
 * this string so the user can run it in a terminal tab.
 */
export const portForwardCommand = (kind, name, mapping, options = {}) =>
  cli(
    options,
    "port-forward",
    `${kindName(kind)}/${resourceName(name)}`,
    portMapping(mapping),
    objectScope(options),
  );
