// The panel's data layer: every kubectl call it makes, over one injected
// `execute(command)`.
//
// A non-zero exit becomes `{ ok: false, failure }` rather than a rejection, so
// the controller never has to distinguish "the cluster said no" from "the
// transport broke". A value that fails validation is different: the method
// REJECTS, because a name the builders refuse means the caller (or the parse it
// came from) is wrong. Every method is `async`, so a refusal can never surface
// as a synchronous throw inside a React event handler.
//
// `scope` is `{ context, namespace, allNamespaces }` and is merged into every
// call, which is how the header's pickers reach the command line — the panel
// never runs `kubectl config use-context`, because that would change the host's
// kubeconfig for every other user of that machine.

import * as get from "./cli/get.js";
import * as session from "./cli/session.js";
import * as workloads from "./cli/workloads.js";
import { sanitizeBin } from "./cli/shell.js";
import { classifyFailure, emptyListMessage } from "./failures.js";
import { parseContainers, parseContexts, parseNameList, parseTable, parseVersion } from "./parse/table.js";

const mergeOutput = (result) =>
  [
    String((result && result.stdout) || "").trimEnd(),
    String((result && result.stderr) || "").trimEnd(),
  ]
    .filter(Boolean)
    .join("\n");

export function createKubectlClient(execute, clientOptions = {}) {
  const base = () => ({
    bin: clientOptions.bin,
    context: clientOptions.context,
    namespace: clientOptions.namespace,
    allNamespaces: clientOptions.allNamespaces,
  });

  /** Merges the ambient scope with a per-call override. */
  const opts = (extra = {}) => ({ ...base(), ...extra });

  const outcome = async (command) => {
    const result = await execute(command);
    return result.exitCode === 0
      ? { ok: true, output: mergeOutput(result), command }
      : { ok: false, failure: classifyFailure(result), output: mergeOutput(result), command };
  };

  const reading = async (command) => {
    const result = await execute(command);
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      text: mergeOutput(result) || "(no output)",
      failure: result.exitCode === 0 ? null : classifyFailure(result),
      command,
    };
  };

  const table = async (command) => {
    const result = await execute(command);
    if (result.exitCode !== 0) {
      return { ok: false, columns: [], rows: [], failure: classifyFailure(result), command };
    }
    const parsed = parseTable(result.stdout);
    return { ok: true, ...parsed, note: emptyListMessage(result), failure: null, command };
  };

  const self = {
    get bin() {
      return sanitizeBin(clientOptions.bin);
    },
    outcome,

    /**
     * A clone with a different scope. Used for a row's own namespace while the
     * listing is in `--all-namespaces`: the row was read with `-A`, but every
     * command against it has to name the namespace it actually lives in.
     */
    withScope: (extra) => createKubectlClient(execute, { ...clientOptions, ...extra }),

    // --- listings ---------------------------------------------------------
    list: async (kind, listOptions = {}) => table(get.getCommand(kind, opts(listOptions))),
    events: async (eventOptions = {}) => table(get.eventsCommand(opts(eventOptions))),
    top: async (what, topOptions = {}) => table(get.topCommand(what, opts(topOptions))),
    apiResources: async () => table(get.apiResourcesCommand(opts())),

    // --- single objects ---------------------------------------------------
    describe: async (kind, name, extra = {}) =>
      reading(get.describeCommand(kind, name, opts(extra))),
    yaml: async (kind, name, extra = {}) => reading(get.yamlCommand(kind, name, opts(extra))),
    explain: async (kind) => reading(get.explainCommand(kind, opts())),
    containers: async (pod, extra = {}) => {
      const result = await execute(get.podContainersCommand(pod, opts(extra)));
      return result.exitCode === 0
        ? { ok: true, containers: parseContainers(result.stdout) }
        : { ok: false, containers: [], failure: classifyFailure(result) };
    },

    // --- kubeconfig / cluster --------------------------------------------
    contexts: async () => {
      const [listed, current] = await Promise.all([
        execute(get.contextsCommand(opts())),
        execute(get.currentContextCommand(opts())),
      ]);
      return {
        ok: listed.exitCode === 0,
        contexts: listed.exitCode === 0 ? parseContexts(listed.stdout) : [],
        current: current.exitCode === 0 ? String(current.stdout || "").trim() : "",
        failure: listed.exitCode === 0 ? null : classifyFailure(listed),
      };
    },
    namespaces: async () => {
      const result = await execute(get.namespacesCommand(opts()));
      return {
        ok: result.exitCode === 0,
        namespaces: result.exitCode === 0 ? parseNameList(result.stdout) : [],
        failure: result.exitCode === 0 ? null : classifyFailure(result),
      };
    },
    version: async () => {
      const result = await execute(get.versionCommand(opts()));
      // The client half is printed even when the API server is unreachable, so
      // the parsed value is kept either way.
      return {
        ok: result.exitCode === 0,
        version: parseVersion(result.stdout),
        failure: result.exitCode === 0 ? null : classifyFailure(result),
      };
    },
    clusterInfo: async () => reading(get.clusterInfoCommand(opts())),

    // --- logs / exec / apply ---------------------------------------------
    logs: async (pod, logOptions = {}) => reading(session.logsCommand(pod, logOptions, opts())),
    workloadLogs: async (kind, name, logOptions = {}) =>
      reading(session.workloadLogsCommand(kind, name, logOptions, opts())),
    exec: async (pod, commandLine, execOptions = {}) =>
      reading(session.execCommand(pod, commandLine, execOptions, opts())),
    apply: async (manifest, applyOptions = {}) =>
      outcome(session.applyCommand(manifest, applyOptions, opts())),
    applyFile: async (path, applyOptions = {}) =>
      outcome(session.applyFileCommand(path, applyOptions, opts())),
    portForwardLine: (kind, name, mapping) =>
      session.portForwardCommand(kind, name, mapping, opts()),

    // --- writes -----------------------------------------------------------
    remove: async (kind, name, deleteOptions = {}) =>
      outcome(workloads.deleteCommand(kind, name, opts(deleteOptions))),
    scale: async (kind, name, replicas) =>
      outcome(workloads.scaleCommand(kind, name, replicas, opts())),
    rollout: async (verb, kind, name, rolloutOptions = {}) =>
      outcome(workloads.rolloutCommand(verb, kind, name, opts(rolloutOptions))),
    setSuspend: async (name, suspend) => outcome(workloads.suspendCommand(name, suspend, opts())),
    triggerCronJob: async (cronjob, jobName) =>
      outcome(workloads.triggerCronJobCommand(cronjob, jobName, opts())),
    cordon: async (node) => outcome(workloads.cordonCommand(node, opts())),
    uncordon: async (node) => outcome(workloads.uncordonCommand(node, opts())),
    drain: async (node, drainOptions = {}) =>
      outcome(workloads.drainCommand(node, opts(drainOptions))),
  };

  return self;
}
