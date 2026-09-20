// The panel's data layer: every docker call it makes, over one injected
// `execute(command)`.
//
// A non-zero exit becomes `{ ok: false, failure }` rather than a rejection, so
// the controller never has to distinguish "the host said no" from "the
// transport broke". A value that fails validation is different: the method
// REJECTS, because a reference the builders refuse means the caller (or the
// parse it came from) is wrong, not that the host is in some state. Every
// method is `async`, so a refusal can never surface as a synchronous throw
// inside a React event handler.

import * as containers from "./cli/containers.js";
import * as images from "./cli/images.js";
import * as objects from "./cli/objects.js";
import * as compose from "./cli/compose.js";
import * as system from "./cli/system.js";
import { sanitizeBin } from "./cli/shell.js";
import { classifyDockerFailure } from "./failures.js";
import * as lists from "./parse/lists.js";
import { parseInfo, parseInspect, parseInspectEntry, parseVersion } from "./parse/objects.js";

const mergeOutput = (result) =>
  [
    String((result && result.stdout) || "").trimEnd(),
    String((result && result.stderr) || "").trimEnd(),
  ]
    .filter(Boolean)
    .join("\n");

export function createDockerClient(execute, clientOptions = {}) {
  const options = { bin: clientOptions.bin };

  /** Runs a command; reports `{ ok, output }` or `{ ok: false, failure }`. */
  const outcome = async (command) => {
    const result = await execute(command);
    return result.exitCode === 0
      ? { ok: true, output: mergeOutput(result), command }
      : { ok: false, failure: classifyDockerFailure(result), output: mergeOutput(result), command };
  };

  /** Runs a listing command and parses its rows. */
  const listing = async (command, parse) => {
    const result = await execute(command);
    return result.exitCode === 0
      ? { ok: true, rows: parse(result.stdout), command }
      : { ok: false, rows: [], failure: classifyDockerFailure(result), command };
  };

  /** Runs an inspect-style command: a summary plus the raw JSON. */
  const inspecting = async (command, summarise) => {
    const result = await execute(command);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        summary: null,
        entry: null,
        raw: "",
        failure: classifyDockerFailure(result),
      };
    }
    return {
      ok: true,
      summary: summarise ? summarise(result.stdout) : null,
      entry: parseInspectEntry(result.stdout),
      raw: String(result.stdout || "").trim(),
      failure: null,
    };
  };

  /** Runs a text command whose output is the content, both streams merged. */
  const reading = async (command) => {
    const result = await execute(command);
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      text: mergeOutput(result) || "(no output)",
      failure: result.exitCode === 0 ? null : classifyDockerFailure(result),
      command,
    };
  };

  return {
    get bin() {
      return sanitizeBin(options.bin);
    },
    outcome,

    // --- containers -------------------------------------------------------
    containers: async () => listing(containers.containersCommand(options), lists.parseContainers),
    stats: async () => listing(containers.containerStatsCommand(options), lists.parseStats),
    containerAction: async (action, reference, actionOptions = {}) =>
      outcome(containers.containerActionCommand(action, reference, { ...options, ...actionOptions })),
    rename: async (reference, name) =>
      outcome(containers.containerRenameCommand(reference, name, options)),
    // `docker logs` exits non-zero when the container is gone, and its message
    // is the only content; it is surfaced as text so the sheet keeps working
    // while a container restarts.
    logs: async (reference, logOptions) =>
      reading(containers.containerLogsCommand(reference, logOptions, options)),
    inspectContainer: async (reference) =>
      inspecting(containers.containerInspectCommand(reference, options), parseInspect),
    top: async (reference) => outcome(containers.containerTopCommand(reference, options)),
    diff: async (reference) => outcome(containers.containerDiffCommand(reference, options)),
    ports: async (reference) => outcome(containers.containerPortCommand(reference, options)),
    exec: async (reference, commandLine, execOptions) =>
      reading(containers.containerExecCommand(reference, commandLine, execOptions, options)),
    run: async (spec) => outcome(containers.runCommand(spec, options)),
    pruneContainers: async () => outcome(containers.containerPruneCommand(options)),

    // --- images -----------------------------------------------------------
    images: async (listOptions) =>
      listing(images.imagesCommand(listOptions, options), lists.parseImages),
    imageHistory: async (reference) =>
      listing(images.imageHistoryCommand(reference, options), lists.parseImageHistory),
    inspectImage: async (reference) => inspecting(images.imageInspectCommand(reference, options)),
    pull: async (reference, pullOptions) =>
      outcome(images.pullCommand(reference, pullOptions, options)),
    push: async (reference) => outcome(images.pushCommand(reference, options)),
    tag: async (source, target) => outcome(images.tagCommand(source, target, options)),
    removeImage: async (reference, removeOptions) =>
      outcome(images.removeImageCommand(reference, removeOptions, options)),
    pruneImages: async (pruneOptions) =>
      outcome(images.pruneImagesCommand(pruneOptions, options)),
    search: async (term, searchOptions) =>
      listing(images.searchCommand(term, searchOptions, options), lists.parseSearch),

    // --- volumes ----------------------------------------------------------
    volumes: async () => listing(objects.volumesCommand(options), lists.parseVolumes),
    createVolume: async (name, createOptions) =>
      outcome(objects.volumeCreateCommand(name, createOptions, options)),
    inspectVolume: async (name) => inspecting(objects.volumeInspectCommand(name, options)),
    removeVolume: async (name, removeOptions) =>
      outcome(objects.volumeRemoveCommand(name, removeOptions, options)),
    pruneVolumes: async (pruneOptions) =>
      outcome(objects.volumePruneCommand(pruneOptions, options)),

    // --- networks ---------------------------------------------------------
    networks: async () => listing(objects.networksCommand(options), lists.parseNetworks),
    createNetwork: async (name, createOptions) =>
      outcome(objects.networkCreateCommand(name, createOptions, options)),
    inspectNetwork: async (name) => inspecting(objects.networkInspectCommand(name, options)),
    removeNetwork: async (name) => outcome(objects.networkRemoveCommand(name, options)),
    pruneNetworks: async () => outcome(objects.networkPruneCommand(options)),
    connectNetwork: async (network, container, connectOptions) =>
      outcome(objects.networkConnectCommand(network, container, connectOptions, options)),
    disconnectNetwork: async (network, container, disconnectOptions) =>
      outcome(objects.networkDisconnectCommand(network, container, disconnectOptions, options)),

    // --- compose ----------------------------------------------------------
    composeProjects: async () =>
      listing(compose.composeProjectsCommand(options), lists.parseComposeProjects),
    composeAction: async (action, target) =>
      outcome(compose.composeActionCommand(action, target, options)),
    composeLogs: async (target, logOptions) =>
      reading(compose.composeLogsCommand(target, logOptions, options)),

    // --- system -----------------------------------------------------------
    diskUsage: async () => listing(system.systemDfCommand(options), lists.parseSystemDf),
    diskUsageVerbose: async () => outcome(system.systemDfVerboseCommand(options)),
    info: async () => {
      const result = await execute(system.infoCommand(options));
      // The parsed value is kept either way: `docker info` still prints the
      // client half when the daemon is unreachable.
      return {
        ok: result.exitCode === 0,
        info: parseInfo(result.stdout),
        failure: result.exitCode === 0 ? null : classifyDockerFailure(result),
      };
    },
    version: async () => {
      const result = await execute(system.versionCommand(options));
      return {
        ok: result.exitCode === 0,
        version: parseVersion(result.stdout),
        failure: result.exitCode === 0 ? null : classifyDockerFailure(result),
      };
    },
    events: async (eventOptions) =>
      listing(system.eventsCommand(eventOptions, options), lists.parseEvents),
    pruneSystem: async (pruneOptions) =>
      outcome(system.systemPruneCommand(pruneOptions, options)),
    pruneBuilder: async (pruneOptions) =>
      outcome(system.builderPruneCommand(pruneOptions, options)),
  };
}
