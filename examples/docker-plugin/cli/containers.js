// Container commands: listing, lifecycle, logs, exec, `docker run`.

import { JSON_FORMAT, assert, cli, positiveInt, shellQuote, tokenizeArgs, when } from "./shell.js";
import {
  bindSpec,
  byteSize,
  containerRef,
  cpuCount,
  envAssignment,
  imageRef,
  networkTarget,
  objectName,
  portSpec,
  restartPolicy,
  signalName,
  timeWindow,
  userSpec,
} from "./validate.js";

export const containersCommand = (options = {}) =>
  cli(options, "ps", "-a", "--no-trunc", JSON_FORMAT);

export const containerStatsCommand = (options = {}) =>
  cli(options, "stats", "--no-stream", "--no-trunc", JSON_FORMAT);

/** Lifecycle verbs, each with the flags the panel is allowed to add. */
const CONTAINER_ACTIONS = new Set(["start", "stop", "restart", "kill", "pause", "unpause", "rm"]);

export function containerActionCommand(action, reference, options = {}) {
  assert(CONTAINER_ACTIONS.has(action), `unsupported docker action: ${action}`);
  const ref = containerRef(reference);
  const extras = [];
  if (
    (action === "stop" || action === "restart") &&
    options.timeout !== undefined &&
    options.timeout !== null &&
    options.timeout !== ""
  ) {
    extras.push("-t", String(positiveInt(options.timeout, 10)));
  }
  if (action === "kill" && options.signal) {
    extras.push("-s", signalName(options.signal));
  }
  if (action === "rm") {
    if (options.force) {
      extras.push("-f");
    }
    if (options.volumes) {
      extras.push("-v");
    }
  }
  return cli(options, action, extras, ref);
}

/**
 * `docker logs`, with stderr folded into stdout on the remote side. The two
 * streams arrive as separate strings over the exec channel, which loses their
 * interleaving; `2>&1` keeps the order the container actually wrote in.
 */
export function containerLogsCommand(reference, logOptions = {}, options = {}) {
  const ref = containerRef(reference);
  const extras = [`--tail ${positiveInt(logOptions.tail, 200)}`];
  if (logOptions.since) {
    extras.push(`--since ${timeWindow(logOptions.since)}`);
  }
  if (logOptions.until) {
    extras.push(`--until ${timeWindow(logOptions.until)}`);
  }
  if (logOptions.timestamps) {
    extras.push("-t");
  }
  if (logOptions.details) {
    extras.push("--details");
  }
  return `${cli(options, "logs", extras, ref)} 2>&1`;
}

export const containerInspectCommand = (reference, options = {}) =>
  cli(options, "container", "inspect", containerRef(reference));

export const containerTopCommand = (reference, options = {}) =>
  cli(options, "top", containerRef(reference), "-eo", "pid,ppid,user,pcpu,pmem,etime,args");

export const containerDiffCommand = (reference, options = {}) =>
  cli(options, "diff", containerRef(reference));

export const containerPortCommand = (reference, options = {}) =>
  cli(options, "port", containerRef(reference));

export const containerRenameCommand = (reference, newName, options = {}) =>
  cli(options, "rename", containerRef(reference), objectName(newName, "container"));

export const containerPruneCommand = (options = {}) => cli(options, "container", "prune", "-f");

/**
 * `docker exec` without a TTY — the exec channel is not interactive, so `-it`
 * would hang. `shell: true` wraps the line in `sh -c` (pipes and redirections
 * work, one quoted argument); otherwise the line is tokenised into argv, which
 * is what the CLI itself does.
 */
export function containerExecCommand(reference, commandLine, execOptions = {}, options = {}) {
  const ref = containerRef(reference);
  const line = String(commandLine ?? "").trim();
  assert(line !== "", "an exec command is required");
  const extras = [];
  if (execOptions.user) {
    extras.push("-u", userSpec(execOptions.user));
  }
  if (execOptions.workdir) {
    extras.push("-w", shellQuote(execOptions.workdir));
  }
  if (execOptions.privileged) {
    extras.push("--privileged");
  }
  for (const entry of execOptions.env || []) {
    extras.push("-e", envAssignment(entry));
  }
  const argv = execOptions.shell
    ? ["sh", "-c", shellQuote(line)]
    : tokenizeArgs(line).map(shellQuote);
  assert(argv.length > 0, "an exec command is required");
  return `${cli(options, "exec", extras, ref, argv)} 2>&1`;
}

/**
 * `docker run`, built from the panel's structured form rather than from a
 * pasted command line. Every field is validated or quoted; unknown fields are
 * ignored, so the form cannot smuggle an extra flag through.
 */
export function runCommand(spec = {}, options = {}) {
  const image = imageRef(spec.image);
  const extras = [];
  if (spec.detach !== false) {
    extras.push("-d");
  }
  if (spec.name) {
    extras.push("--name", objectName(spec.name, "container"));
  }
  if (spec.autoRemove) {
    extras.push("--rm");
  }
  if (spec.restart) {
    // docker itself refuses this pair.
    assert(!spec.autoRemove, "--rm cannot be combined with a restart policy");
    extras.push(`--restart=${restartPolicy(spec.restart)}`);
  }
  if (spec.network) {
    extras.push("--network", networkTarget(spec.network));
  }
  if (spec.user) {
    extras.push("-u", userSpec(spec.user));
  }
  if (spec.workdir) {
    extras.push("-w", shellQuote(spec.workdir));
  }
  if (spec.hostname) {
    extras.push("--hostname", objectName(spec.hostname, "hostname"));
  }
  if (spec.memory) {
    extras.push(`--memory=${byteSize(spec.memory)}`);
  }
  if (spec.cpus) {
    extras.push(`--cpus=${cpuCount(spec.cpus)}`);
  }
  extras.push(...when(spec.privileged, "--privileged"), ...when(spec.publishAll, "-P"));
  for (const entry of spec.ports || []) {
    extras.push("-p", portSpec(entry));
  }
  for (const entry of spec.env || []) {
    extras.push("-e", envAssignment(entry));
  }
  for (const entry of spec.volumes || []) {
    extras.push("-v", bindSpec(entry));
  }
  for (const entry of spec.labels || []) {
    extras.push("-l", envAssignment(entry));
  }
  if (spec.entrypoint) {
    extras.push("--entrypoint", shellQuote(spec.entrypoint));
  }
  const argv = spec.command ? tokenizeArgs(spec.command).map(shellQuote) : [];
  return cli(options, "run", extras, image, argv);
}
