// Parsers for docker's single-object JSON output: inspect, info, version.

import { text } from "./lists.js";

/**
 * `docker inspect` emits a JSON array. Returns `null` when the output cannot be
 * read, so the caller can show the raw text instead of an empty panel.
 */
export function parseInspectEntry(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const entry = Array.isArray(data) ? data[0] : data;
  return entry && typeof entry === "object" ? entry : null;
}

const at = (entry, ...path) => {
  let value = entry;
  for (const key of path) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    value = value[key];
  }
  return value;
};

/** `docker container inspect`, reduced to what the Inspect sheet shows. */
export function parseInspect(stdout) {
  const entry = parseInspectEntry(stdout);
  if (!entry) {
    return null;
  }
  const state = entry.State || {};
  const net = entry.NetworkSettings || {};
  const ports = Object.entries(net.Ports || {}).flatMap(([containerPort, bindings]) =>
    bindings && bindings.length
      ? bindings.map(
          (binding) => `${binding.HostIp || "0.0.0.0"}:${binding.HostPort}->${containerPort}`,
        )
      : [containerPort],
  );
  return {
    id: text(entry.Id),
    name: text(entry.Name).replace(/^\//, ""),
    image: text(at(entry, "Config", "Image")),
    imageId: text(entry.Image),
    created: text(entry.Created),
    status: text(state.Status),
    health: text(at(state, "Health", "Status")),
    startedAt: text(state.StartedAt),
    finishedAt: text(state.FinishedAt),
    exitCode: state.ExitCode,
    pid: state.Pid,
    restartCount: entry.RestartCount,
    restartPolicy: text(at(entry, "HostConfig", "RestartPolicy", "Name")),
    command: [entry.Path, ...(entry.Args || [])].filter(Boolean).join(" "),
    entrypoint: [].concat(at(entry, "Config", "Entrypoint") || []).join(" "),
    workingDir: text(at(entry, "Config", "WorkingDir")),
    user: text(at(entry, "Config", "User")),
    logDriver: text(at(entry, "HostConfig", "LogConfig", "Type")),
    ports,
    mounts: (entry.Mounts || []).map(
      (mount) =>
        `${mount.Source || mount.Name} → ${mount.Destination}${mount.RW === false ? " (ro)" : ""}`,
    ),
    networks: Object.entries(net.Networks || {}).map(([name, value]) =>
      value && value.IPAddress ? `${name} (${value.IPAddress})` : name,
    ),
    env: at(entry, "Config", "Env") || [],
    labels: at(entry, "Config", "Labels") || {},
  };
}

/** `docker info --format '{{json .}}'`. */
export function parseInfo(stdout) {
  const entry = parseInspectEntry(stdout);
  if (!entry) {
    return null;
  }
  return {
    name: text(entry.Name),
    serverVersion: text(entry.ServerVersion),
    operatingSystem: text(entry.OperatingSystem),
    osType: text(entry.OSType),
    architecture: text(entry.Architecture),
    kernelVersion: text(entry.KernelVersion),
    cpus: entry.NCPU,
    memTotal: entry.MemTotal,
    storageDriver: text(entry.Driver),
    loggingDriver: text(entry.LoggingDriver),
    cgroupDriver: text(entry.CgroupDriver),
    cgroupVersion: text(entry.CgroupVersion),
    containers: entry.Containers,
    containersRunning: entry.ContainersRunning,
    containersPaused: entry.ContainersPaused,
    containersStopped: entry.ContainersStopped,
    images: entry.Images,
    rootDir: text(entry.DockerRootDir),
    // `docker info` still prints the client half when the daemon is down.
    live: Boolean(entry.ServerVersion),
    warnings: [].concat(entry.Warnings || []).map(text),
    serverErrors: [].concat(entry.ServerErrors || []).map(text),
  };
}

/** `docker version --format '{{json .}}'`. `Server` may be absent. */
export function parseVersion(stdout) {
  const entry = parseInspectEntry(stdout);
  if (!entry) {
    return null;
  }
  const client = entry.Client || {};
  const server = entry.Server || null;
  const engine =
    server && [].concat(server.Components || []).find((part) => part && part.Name === "Engine");
  return {
    clientVersion: text(client.Version),
    clientApi: text(client.ApiVersion),
    clientPlatform: text(at(client, "Platform", "Name")),
    serverVersion: text(server && server.Version),
    serverApi: text(server && server.ApiVersion),
    serverOs: server ? `${text(server.Os)}${server.Arch ? `/${text(server.Arch)}` : ""}` : "",
    engineVersion: text(engine && engine.Version),
  };
}
