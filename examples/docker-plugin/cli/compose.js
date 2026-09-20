// Compose v2 commands.
//
// A project is addressed by `-p <name>` plus the `-f <file>` list docker
// recorded on its containers (or that `compose ls` reports). `ps`, `logs`,
// `stop`, `start` and `restart` work from `-p` alone on a live project; `up`,
// `down`, `pull` and `config` need the files, so the panel only offers them
// when it knows where they are.

import { assert, cli, positiveInt, shellQuote } from "./shell.js";
import { objectName } from "./validate.js";

export const composeProjectsCommand = (options = {}) =>
  cli(options, "compose", "ls", "--all", "--format", "json");

const COMPOSE_ACTIONS = new Set(["up", "down", "start", "stop", "restart", "pull", "ps", "config"]);
const NEEDS_FILES = new Set(["up", "down", "config", "pull"]);

const usableFiles = (files) => (files || []).filter((file) => String(file ?? "").trim() !== "");

function composeScope(project, files, workingDir) {
  const parts = ["compose", "-p", objectName(project, "compose project")];
  for (const file of usableFiles(files)) {
    parts.push("-f", shellQuote(String(file).trim()));
  }
  const dir = String(workingDir ?? "").trim();
  if (dir) {
    parts.push("--project-directory", shellQuote(dir));
  }
  return parts;
}

export function composeActionCommand(action, target = {}, options = {}) {
  assert(COMPOSE_ACTIONS.has(action), `unsupported compose action: ${action}`);
  const files = usableFiles(target.files);
  assert(
    !NEEDS_FILES.has(action) || files.length > 0,
    `compose ${action} needs the project's compose file, which this project does not report`,
  );
  const extras = [];
  if (action === "up") {
    extras.push("-d");
    if (target.recreate) {
      extras.push("--force-recreate");
    }
    if (target.build) {
      extras.push("--build");
    }
  }
  if (action === "down") {
    if (target.volumes) {
      extras.push("-v");
    }
    if (target.removeOrphans) {
      extras.push("--remove-orphans");
    }
  }
  if (action === "ps") {
    extras.push("-a", "--format", "json");
  }
  const services = (target.services || []).map((service) => objectName(service, "compose service"));
  return cli(options, composeScope(target.project, files, target.workingDir), action, extras, services);
}

export function composeLogsCommand(target = {}, logOptions = {}, options = {}) {
  const extras = ["--no-color", `--tail=${positiveInt(logOptions.tail, 200)}`];
  if (logOptions.timestamps) {
    extras.push("-t");
  }
  const services = (target.services || []).map((service) => objectName(service, "compose service"));
  const scope = composeScope(target.project, target.files, target.workingDir);
  return `${cli(options, scope, "logs", extras, services)} 2>&1`;
}
