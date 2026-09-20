// Daemon-wide commands: info, version, disk usage, events, prune.

import { JSON_FORMAT, cli, when } from "./shell.js";
import { timeWindow } from "./validate.js";

export const systemDfCommand = (options = {}) => cli(options, "system", "df", JSON_FORMAT);
export const systemDfVerboseCommand = (options = {}) => cli(options, "system", "df", "-v");
export const infoCommand = (options = {}) => cli(options, "info", JSON_FORMAT);
export const versionCommand = (options = {}) => cli(options, "version", JSON_FORMAT);

/**
 * A bounded `docker events` window. `--until 0s` resolves to "now", which is
 * what makes the command return: an exec channel cannot interrupt an open
 * stream, so an unbounded `docker events` would hold the command until the
 * backend's 30-minute timeout.
 */
export const eventsCommand = (eventOptions = {}, options = {}) =>
  cli(
    options,
    "events",
    `--since ${timeWindow(eventOptions.since ?? "30m")}`,
    "--until 0s",
    JSON_FORMAT,
  );

export const systemPruneCommand = (pruneOptions = {}, options = {}) =>
  cli(
    options,
    "system",
    "prune",
    "-f",
    when(pruneOptions.all, "-a"),
    when(pruneOptions.volumes, "--volumes"),
  );

export const builderPruneCommand = (pruneOptions = {}, options = {}) =>
  cli(options, "builder", "prune", "-f", when(pruneOptions.all, "-a"));
