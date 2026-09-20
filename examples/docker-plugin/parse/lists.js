// Parsers for docker's list output (`--format '{{json .}}'`).

export const splitLines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");

export const text = (value) => (value === null || value === undefined ? "" : String(value));

/**
 * Reads one JSON object per line. Also accepts a single JSON array, which is
 * what `compose ls --format json` and newer `compose ps --format json` emit.
 * Unparseable lines are skipped rather than failing the whole listing — one
 * malformed record should not blank a panel.
 */
export function parseJsonRows(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return [];
  }
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry) => entry && typeof entry === "object");
      }
    } catch {
      // Fall through to the line-by-line read.
    }
  }
  const rows = [];
  for (const line of splitLines(raw)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        rows.push(parsed);
      }
    } catch {
      // Not JSON: skip it.
    }
  }
  return rows;
}

/** `Labels` arrives as one `k=v,k=v` string. */
export function parseLabels(input) {
  const labels = {};
  for (const pair of String(input ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      labels[trimmed] = "";
    } else {
      labels[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    }
  }
  return labels;
}

/**
 * `.State` only exists in `docker ps --format` from 20.10 on, so it is
 * recovered from the human `Status` string when missing. The values are
 * docker's own: created, restarting, running, removing, paused, exited, dead.
 */
export function deriveState(state, status) {
  const explicit = String(state ?? "").trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const value = String(status ?? "").trim();
  if (/^up\b/i.test(value)) {
    return /\(paused\)/i.test(value) ? "paused" : "running";
  }
  if (/^exited\b/i.test(value)) {
    return "exited";
  }
  if (/^created\b/i.test(value)) {
    return "created";
  }
  if (/^restarting\b/i.test(value)) {
    return "restarting";
  }
  if (/^removal|^removing\b/i.test(value)) {
    return "removing";
  }
  if (/^dead\b/i.test(value)) {
    return "dead";
  }
  return "unknown";
}

const list = (value) => text(value).split(",").filter(Boolean);

export function parseContainers(stdout) {
  return parseJsonRows(stdout).map((row) => {
    const labels = parseLabels(row.Labels);
    const state = deriveState(row.State, row.Status);
    const names = text(row.Names);
    const id = text(row.ID || row.Id);
    return {
      id,
      shortId: id.slice(0, 12),
      name: names.split(",")[0] || id.slice(0, 12),
      names: list(names),
      image: text(row.Image),
      command: text(row.Command).replace(/^"|"$/g, ""),
      state,
      status: text(row.Status),
      ports: text(row.Ports),
      createdAt: text(row.CreatedAt),
      runningFor: text(row.RunningFor),
      size: text(row.Size),
      mounts: list(row.Mounts),
      networks: list(row.Networks),
      labels,
      composeProject: labels["com.docker.compose.project"] || "",
      composeService: labels["com.docker.compose.service"] || "",
      composeFiles: list(labels["com.docker.compose.project.config_files"]).map((file) => file.trim()),
      composeWorkingDir: labels["com.docker.compose.project.working_dir"] || "",
      running: state === "running",
      paused: state === "paused",
      // `docker rm` refuses a running or paused container without `-f`.
      removable: state !== "running" && state !== "paused",
    };
  });
}

export function parseImages(stdout) {
  return parseJsonRows(stdout).map((row) => {
    const repository = text(row.Repository);
    const tag = text(row.Tag);
    const tagged = tag && tag !== "<none>";
    const digest = text(row.Digest);
    const id = text(row.ID || row.Id);
    return {
      id,
      shortId: id.replace(/^sha256:/, "").slice(0, 12),
      repository,
      tag,
      digest: digest === "<none>" ? "" : digest,
      size: text(row.Size),
      createdSince: text(row.CreatedSince),
      createdAt: text(row.CreatedAt),
      dangling: !tagged && repository === "<none>",
      reference: tagged ? `${repository}:${tag}` : repository || "<none>",
    };
  });
}

export function parseVolumes(stdout) {
  return parseJsonRows(stdout).map((row) => ({
    name: text(row.Name),
    driver: text(row.Driver),
    scope: text(row.Scope),
    mountpoint: text(row.Mountpoint),
    labels: parseLabels(row.Labels),
    size: text(row.Size) === "N/A" ? "" : text(row.Size),
  }));
}

export function parseNetworks(stdout) {
  return parseJsonRows(stdout).map((row) => {
    const id = text(row.ID || row.Id);
    return {
      id,
      shortId: id.slice(0, 12),
      name: text(row.Name),
      driver: text(row.Driver),
      scope: text(row.Scope),
      ipv6: text(row.IPv6) === "true",
      internal: text(row.Internal) === "true",
      createdAt: text(row.CreatedAt),
      labels: parseLabels(row.Labels),
      // `docker network rm` refuses the three predefined networks.
      predefined: ["bridge", "host", "none"].includes(text(row.Name)),
    };
  });
}

const percent = (value) => {
  const numeric = Number.parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(numeric) ? numeric : null;
};

export function parseStats(stdout) {
  return parseJsonRows(stdout).map((row) => ({
    id: text(row.ID || row.Container),
    name: text(row.Name),
    cpuPercent: percent(row.CPUPerc),
    cpuText: text(row.CPUPerc),
    memPercent: percent(row.MemPerc),
    memUsage: text(row.MemUsage),
    netIo: text(row.NetIO),
    blockIo: text(row.BlockIO),
    pids: text(row.PIDs),
  }));
}

export function parseSystemDf(stdout) {
  return parseJsonRows(stdout).map((row) => ({
    type: text(row.Type),
    total: text(row.TotalCount),
    active: text(row.Active),
    size: text(row.Size),
    reclaimable: text(row.Reclaimable),
  }));
}

export function parseImageHistory(stdout) {
  return parseJsonRows(stdout).map((row) => ({
    id: text(row.ID || row.Id),
    createdSince: text(row.CreatedSince),
    createdBy: text(row.CreatedBy),
    size: text(row.Size),
    comment: text(row.Comment),
  }));
}

export function parseSearch(stdout) {
  return parseJsonRows(stdout).map((row) => ({
    name: text(row.Name),
    description: text(row.Description),
    stars: text(row.StarCount),
    official: text(row.IsOfficial) === "[OK]" || text(row.IsOfficial) === "true",
  }));
}

export function parseEvents(stdout) {
  return parseJsonRows(stdout).map((row) => {
    const attributes = (row.Actor && row.Actor.Attributes) || {};
    const seconds = Number(row.time);
    return {
      time: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "",
      type: text(row.Type),
      action: text(row.Action || row.status),
      id: text((row.Actor && row.Actor.ID) || row.id),
      name: text(attributes.name || attributes.container || ""),
      image: text(attributes.image || row.from || ""),
      attributes,
    };
  });
}

/** `docker compose ls --format json`, or its table output as a fallback. */
export function parseComposeProjects(stdout) {
  const rows = parseJsonRows(stdout);
  const files = (value) =>
    text(value)
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean);
  if (rows.length > 0) {
    return rows.map((row) => ({
      name: text(row.Name),
      status: text(row.Status),
      files: files(row.ConfigFiles),
    }));
  }
  const lines = splitLines(stdout);
  if (lines.length < 2 || !/^NAME\b/i.test(lines[0])) {
    return [];
  }
  return lines.slice(1).map((line) => {
    const [name, status, configFiles] = line.split(/\s{2,}/);
    return { name: text(name).trim(), status: text(status).trim(), files: files(configFiles) };
  });
}
