// Write commands: delete, scale, rollout, CronJob suspend/trigger, and the node
// maintenance verbs.
//
// Every one of these changes the cluster, so the panel puts a confirmation in
// front of it that shows exactly the string built here.

import { assert, cli, positiveInt, when } from "./shell.js";
import { contextFlag, objectScope, resourceName, target } from "./validate.js";

export function deleteCommand(kind, name, options = {}) {
  const extras = [];
  if (options.force) {
    // kubectl only honours `--force` together with a zero grace period.
    extras.push("--force", "--grace-period=0");
  } else if (options.gracePeriod !== undefined && options.gracePeriod !== null) {
    extras.push(`--grace-period=${positiveInt(options.gracePeriod, 30)}`);
  }
  if (options.wait === false) {
    extras.push("--wait=false");
  }
  return cli(options, "delete", target(kind, name), objectScope(options), extras);
}

const SCALABLE = new Set(["deployment", "deployments", "statefulset", "statefulsets", "replicaset", "replicasets", "rc", "replicationcontroller", "deploy", "sts", "rs"]);

export function scaleCommand(kind, name, replicas, options = {}) {
  assert(SCALABLE.has(String(kind).toLowerCase()), `${kind} cannot be scaled`);
  const count = Number(replicas);
  assert(
    Number.isInteger(count) && count >= 0 && count <= 10_000,
    "replicas must be an integer between 0 and 10000",
  );
  return cli(options, "scale", target(kind, name), objectScope(options), `--replicas=${count}`);
}

const ROLLOUT_VERBS = new Set(["restart", "status", "history", "undo", "pause", "resume"]);

export function rolloutCommand(verb, kind, name, options = {}) {
  assert(ROLLOUT_VERBS.has(verb), `unsupported rollout verb: ${verb}`);
  const extras = [];
  if (verb === "status") {
    // Without a timeout, `rollout status` blocks until the rollout finishes —
    // which a stuck deployment never does.
    extras.push(`--timeout=${positiveInt(options.timeout, 60)}s`);
  }
  if (verb === "undo" && options.revision) {
    extras.push(`--to-revision=${positiveInt(options.revision, 1)}`);
  }
  return cli(options, "rollout", verb, target(kind, name), objectScope(options), extras);
}

/**
 * CronJob suspend/resume. The patch body is a fixed literal, not user input, so
 * single-quoting it is enough; nothing interpolates into the JSON.
 */
export const suspendCommand = (name, suspend, options = {}) =>
  cli(
    options,
    "patch",
    target("cronjob", name),
    objectScope(options),
    "-p",
    `'{"spec":{"suspend":${suspend ? "true" : "false"}}}'`,
  );

/** `kubectl create job <name> --from=cronjob/<cronjob>` — a manual run. */
export const triggerCronJobCommand = (cronjob, jobName, options = {}) =>
  cli(
    options,
    "create",
    "job",
    resourceName(jobName),
    objectScope(options),
    `--from=cronjob/${resourceName(cronjob)}`,
  );

export const cordonCommand = (node, options = {}) =>
  cli(options, "cordon", resourceName(node), contextFlag(options.context));

export const uncordonCommand = (node, options = {}) =>
  cli(options, "uncordon", resourceName(node), contextFlag(options.context));

/**
 * `kubectl drain`. The two flags are not optional in practice: without
 * `--ignore-daemonsets` the command refuses on any node running a DaemonSet,
 * and without `--delete-emptydir-data` it refuses on pods with emptyDir
 * volumes. `--force` (evicting unmanaged pods) stays opt-in.
 */
export const drainCommand = (node, options = {}) =>
  cli(
    options,
    "drain",
    resourceName(node),
    contextFlag(options.context),
    "--ignore-daemonsets",
    "--delete-emptydir-data",
    when(options.force, "--force"),
    `--timeout=${positiveInt(options.timeout, 120)}s`,
  );

// Deliberately absent: a selector-wide `kubectl delete -l …` and a namespace-wide
// `rollout restart`. Both are one command in the CLI and a cluster-wide outage
// in one click; the panel's bulk actions operate on rows the user ticked.
