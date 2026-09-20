// Volume and network commands.

import { JSON_FORMAT, cli, when } from "./shell.js";
import {
  cidr,
  containerRef,
  driverName,
  envAssignment,
  ipAddress,
  objectName,
} from "./validate.js";

// --- volumes ---------------------------------------------------------------

export const volumesCommand = (options = {}) => cli(options, "volume", "ls", JSON_FORMAT);

export function volumeCreateCommand(name, createOptions = {}, options = {}) {
  const extras = [];
  if (createOptions.driver) {
    extras.push("-d", driverName(createOptions.driver));
  }
  for (const entry of createOptions.labels || []) {
    extras.push("--label", envAssignment(entry));
  }
  return cli(options, "volume", "create", extras, objectName(name, "volume"));
}

export const volumeInspectCommand = (name, options = {}) =>
  cli(options, "volume", "inspect", objectName(name, "volume"));

export const volumeRemoveCommand = (name, removeOptions = {}, options = {}) =>
  cli(options, "volume", "rm", when(removeOptions.force, "-f"), objectName(name, "volume"));

export const volumePruneCommand = (pruneOptions = {}, options = {}) =>
  cli(options, "volume", "prune", "-f", when(pruneOptions.all, "-a"));

// --- networks --------------------------------------------------------------

export const networksCommand = (options = {}) =>
  cli(options, "network", "ls", "--no-trunc", JSON_FORMAT);

export function networkCreateCommand(name, createOptions = {}, options = {}) {
  const extras = [];
  if (createOptions.driver) {
    extras.push("-d", driverName(createOptions.driver));
  }
  if (createOptions.subnet) {
    extras.push(`--subnet=${cidr(createOptions.subnet)}`);
  }
  if (createOptions.gateway) {
    extras.push(`--gateway=${ipAddress(createOptions.gateway)}`);
  }
  extras.push(
    ...when(createOptions.internal, "--internal"),
    ...when(createOptions.ipv6, "--ipv6"),
    ...when(createOptions.attachable, "--attachable"),
  );
  return cli(options, "network", "create", extras, objectName(name, "network"));
}

export const networkInspectCommand = (name, options = {}) =>
  cli(options, "network", "inspect", objectName(name, "network"));

export const networkRemoveCommand = (name, options = {}) =>
  cli(options, "network", "rm", objectName(name, "network"));

export const networkPruneCommand = (options = {}) => cli(options, "network", "prune", "-f");

export const networkConnectCommand = (network, container, connectOptions = {}, options = {}) =>
  cli(
    options,
    "network",
    "connect",
    connectOptions.alias ? ["--alias", objectName(connectOptions.alias, "network alias")] : [],
    objectName(network, "network"),
    containerRef(container),
  );

export const networkDisconnectCommand = (network, container, disconnectOptions = {}, options = {}) =>
  cli(
    options,
    "network",
    "disconnect",
    when(disconnectOptions.force, "-f"),
    objectName(network, "network"),
    containerRef(container),
  );
