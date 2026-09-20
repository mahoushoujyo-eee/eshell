// Read-only commands: `get`, `describe`, `-o yaml`, `explain`, `top`, events,
// and the cluster/kubeconfig queries the header needs.
//
// Listings use `-o wide` and are parsed from kubectl's own table, which is what
// makes any resource type work — including CRDs, whose columns the server
// decides. `-o json` would be a much larger read for the same rows.
//
// Flags always come after the subcommand and its positional arguments: `-A` is
// local to the listing subcommands, and a flag kubectl does not recognise at
// root level is routed to its plugin resolver instead ("flags cannot be placed
// before plugin name").

import { cli } from "./shell.js";
import {
  contextFlag,
  duration,
  kindName,
  listScope,
  objectScope,
  resourceName,
  selector,
  sortBy,
  target,
} from "./validate.js";

export function getCommand(kind, options = {}) {
  const extras = ["-o", "wide"];
  if (options.selector) {
    extras.push("-l", selector(options.selector));
  }
  if (options.fieldSelector) {
    extras.push(`--field-selector=${selector(options.fieldSelector)}`);
  }
  if (options.sortBy) {
    extras.push(`--sort-by=${sortBy(options.sortBy)}`);
  }
  if (options.showLabels) {
    extras.push("--show-labels");
  }
  return cli(options, "get", kindName(kind), listScope(options), extras);
}

export const describeCommand = (kind, name, options = {}) =>
  cli(options, "describe", target(kind, name), objectScope(options));

export const yamlCommand = (kind, name, options = {}) =>
  cli(options, "get", target(kind, name), objectScope(options), "-o", "yaml");

export const explainCommand = (kind, options = {}) =>
  cli(options, "explain", kindName(kind), contextFlag(options.context), "--recursive");

export const apiResourcesCommand = (options = {}) =>
  cli(options, "api-resources", contextFlag(options.context), "-o", "wide");

/**
 * Events for one object, or for the whole namespace. `--sort-by` puts the most
 * recent last, which is the order `kubectl describe` shows them in.
 */
export function eventsCommand(options = {}) {
  const extras = ["--sort-by=.lastTimestamp"];
  if (options.objectName) {
    extras.push(`--field-selector=involvedObject.name=${resourceName(options.objectName)}`);
  }
  // One object's events are read from that object's namespace, not from `-A`.
  const scope = options.objectName ? objectScope(options) : listScope(options);
  return cli(options, "get", "events", scope, extras);
}

/**
 * `kubectl top`, for every node/pod or for one named object. Needs
 * metrics-server; the failure classifier explains that.
 */
export function topCommand(what, options = {}) {
  const name = options.name ? resourceName(options.name) : "";
  if (what === "nodes") {
    return cli(options, "top", "nodes", name, contextFlag(options.context));
  }
  return cli(
    options,
    "top",
    "pods",
    name,
    name ? objectScope(options) : listScope(options),
    options.containers ? "--containers" : "",
  );
}

// --- kubeconfig / cluster -------------------------------------------------

export const contextsCommand = (options = {}) =>
  cli(options, "config", "get-contexts", "-o", "name");

export const currentContextCommand = (options = {}) => cli(options, "config", "current-context");

export const namespacesCommand = (options = {}) =>
  cli(options, "get", "namespaces", contextFlag(options.context), "-o", "name");

export const versionCommand = (options = {}) =>
  cli(options, "version", contextFlag(options.context), "-o", "json");

export const clusterInfoCommand = (options = {}) =>
  cli(options, "cluster-info", contextFlag(options.context));

/**
 * The containers of one pod, for the log and exec pickers. `-o jsonpath` is the
 * right read here: two short lists instead of the pod's whole manifest. Literal
 * text outside `{}` is emitted as-is, so each line arrives tagged with which
 * list it came from — `kubectl logs -c` needs to know about init containers.
 */
export const podContainersCommand = (name, options = {}) =>
  cli(
    options,
    "get",
    `pod/${resourceName(name)}`,
    objectScope(options),
    "-o",
    `jsonpath='{range .spec.initContainers[*]}init/{.name}{"\\n"}{end}{range .spec.containers[*]}main/{.name}{"\\n"}{end}'`,
  );

/** `--since` is shared by logs and by the events window. */
export const sinceFlag = (value) => (value ? `--since=${duration(value)}` : "");
