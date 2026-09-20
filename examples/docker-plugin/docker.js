// Pure helpers for the Docker panel: the exact commands it runs, the parsers
// for their output, and the data layer the controller drives. No React and no
// plugin facade here, so the whole command/parse/classify path is testable on
// its own.

// Docker's Go-template formatter turns `\t` into a real tab, so one output
// line is one record with a fixed field count. A tab is safe as the
// separator: none of the selected fields can contain one.
const CONTAINER_FORMAT =
  "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}";
const IMAGE_FORMAT =
  "{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}";
const SYSTEM_DF_FORMAT =
  "{{.Type}}\\t{{.TotalCount}}\\t{{.Size}}\\t{{.Reclaimable}}";

export const containersCommand = () => `docker ps -a --format '${CONTAINER_FORMAT}'`;
export const imagesCommand = () => `docker images --format '${IMAGE_FORMAT}'`;
export const systemDfCommand = () => `docker system df --format '${SYSTEM_DF_FORMAT}'`;
export const pruneImagesCommand = () => "docker image prune -f";

// Container ids come from docker itself, but they still reach a shell command
// line. Anything that is not a plain hex id is refused rather than quoted: a
// malformed id means the parse went wrong, not that we should guess.
const SAFE_ID = /^[0-9a-f]{6,64}$/i;

// `docker images --format '{{.ID}}'` yields a bare short id on most versions
// but `sha256:...` on others, and `docker rmi`/`inspect` accept either. The
// optional prefix is the only difference from a container id.
const SAFE_IMAGE_ID = /^(sha256:)?[0-9a-f]{6,64}$/i;

// A pull reference: registry host, path, tag, and digest are all allowed; the
// first character must be alphanumeric so a reference can never be read as a
// flag. Nothing here can carry shell syntax — no space, quote, `;`, `|`, `&`,
// `$`, backtick, glob, or newline.
const SAFE_IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;

export const isSafeId = (id) => SAFE_ID.test(String(id ?? ""));
export const isSafeImageId = (id) => SAFE_IMAGE_ID.test(String(id ?? ""));
export const isSafeImageRef = (ref) => SAFE_IMAGE_REF.test(String(ref ?? ""));

const CONTAINER_ACTIONS = new Set([
  "start",
  "stop",
  "restart",
  "rm",
  "pause",
  "unpause",
]);

export function dockerActionCommand(action, id) {
  if (!CONTAINER_ACTIONS.has(action)) {
    throw new Error(`unsupported docker action: ${action}`);
  }
  if (!isSafeId(id)) {
    throw new Error(`refusing to run "docker ${action}" on an unexpected id`);
  }
  return `docker ${action} ${id}`;
}

export function containerLogsCommand(id, tail = 200) {
  if (!isSafeId(id)) {
    throw new Error("refusing to read logs for an unexpected id");
  }
  const lines = Number.isFinite(Number(tail)) ? Math.max(1, Math.trunc(Number(tail))) : 200;
  return `docker logs --tail ${lines} ${id}`;
}

export function inspectCommand(id) {
  if (!isSafeId(id)) {
    throw new Error("refusing to inspect an unexpected id");
  }
  return `docker inspect ${id}`;
}

export function pullCommand(reference) {
  if (!isSafeImageRef(reference)) {
    throw new Error("refusing to pull an unexpected image reference");
  }
  return `docker pull ${reference}`;
}

export function removeImageCommand(id) {
  if (!isSafeImageId(id)) {
    throw new Error("refusing to remove an unexpected image id");
  }
  return `docker rmi ${id}`;
}

const splitLines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");

// Docker omits trailing empty fields, so a record can be shorter than the
// format's field count. Pad rather than destructure into undefined.
const fields = (line, count) => {
  const parts = line.split("\t");
  while (parts.length < count) {
    parts.push("");
  }
  return parts.slice(0, count);
};

export function parseContainers(stdout) {
  return splitLines(stdout).map((line) => {
    const [id, names, image, state, status, ports] = fields(line, 6);
    return {
      id,
      // `.Names` is comma-separated when a container carries several names.
      name: names.split(",")[0] || id.slice(0, 12),
      image,
      state: state || "unknown",
      status,
      ports,
      running: state === "running",
      paused: state === "paused",
    };
  });
}

export function parseImages(stdout) {
  return splitLines(stdout).map((line) => {
    const [id, repository, tag, size, createdSince] = fields(line, 5);
    const tagged = tag && tag !== "<none>";
    return {
      id,
      repository,
      tag,
      size,
      createdSince,
      reference: tagged ? `${repository}:${tag}` : repository || "<none>",
    };
  });
}

export function parseSystemDf(stdout) {
  return splitLines(stdout).map((line) => {
    const [type, count, size, reclaimable] = fields(line, 4);
    return { type, count, size, reclaimable };
  });
}

// `docker inspect` emits a JSON array. Returns null when the output is not
// parseable, so the caller can show the raw text instead of an empty panel.
export function parseInspect(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const state = entry.State || {};
  const net = entry.NetworkSettings || {};
  const ports = Object.entries(net.Ports || {}).flatMap(([containerPort, bindings]) =>
    bindings && bindings.length
      ? bindings.map((b) => `${b.HostIp || "0.0.0.0"}:${b.HostPort}->${containerPort}`)
      : [containerPort],
  );
  return {
    id: entry.Id || "",
    name: String(entry.Name || "").replace(/^\//, ""),
    image: entry.Config?.Image || "",
    created: entry.Created || "",
    status: state.Status || "",
    health: state.Health?.Status || "",
    startedAt: state.StartedAt || "",
    exitCode: state.ExitCode,
    restartPolicy: entry.HostConfig?.RestartPolicy?.Name || "",
    command: [entry.Path, ...(entry.Args || [])].filter(Boolean).join(" "),
    ports,
    mounts: (entry.Mounts || []).map(
      (m) => `${m.Source} → ${m.Destination}${m.RW === false ? " (ro)" : ""}`,
    ),
    networks: Object.keys(net.Networks || {}),
    env: entry.Config?.Env || [],
  };
}

// Turns a failed `docker` invocation into something the panel can explain.
// The kinds are the three failures a user can actually act on; everything
// else keeps docker's own message.
export function classifyDockerFailure(result) {
  const stderr = String(result?.stderr ?? "");
  const stdout = String(result?.stdout ?? "");
  const text = `${stderr}\n${stdout}`;

  // The raw text is kept on every branch: the panel shows it under the
  // friendly sentence, because the exact path in "permission denied while
  // trying to connect to the Docker daemon socket at unix:///..." is what
  // tells the user whether it is the socket, the binary, or something else.
  const detail = stderr.trim() || stdout.trim();

  if (/command not found|not recognized as an internal/i.test(text)) {
    return { kind: "missing", detail };
  }
  if (/permission denied/i.test(text)) {
    return { kind: "permission", detail };
  }
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(text)) {
    return { kind: "daemon", detail };
  }
  return {
    kind: "error",
    detail,
    message: detail || `docker exited with code ${result?.exitCode}`,
  };
}

// The user-facing sentence for a classified failure, plus the fix when there
// is one. Kept next to the classifier so the wording and the detection stay
// in one place.
export function describeDockerFailure(failure) {
  switch (failure?.kind) {
    case "missing":
      return {
        text: "docker was not found on the remote host.",
        hint: "Install docker, or check that it is on the PATH of a non-interactive SSH command.",
      };
    case "permission":
      return {
        text: "Permission denied — the SSH user cannot reach the Docker socket.",
        // The group change only takes effect on a NEW connection: the
        // supplementary group list is read at login, and the plugin's
        // commands run on a separate exec channel that inherits the
        // credentials from when the session was opened. `newgrp` in the
        // interactive shell does not help here.
        hint:
          "Run `sudo usermod -aG docker $USER` on the host, then reconnect this session — " +
          "an existing connection keeps the old group list.",
      };
    case "daemon":
      return {
        text: "Cannot connect to the Docker daemon on the remote host.",
        hint: "Start it with `sudo systemctl start docker`, or check that it is running at all.",
      };
    default:
      return {
        text: failure?.message || "docker command failed.",
        hint: failure?.detail || "",
      };
  }
}

/**
 * The panel's data layer: every docker call it makes, over one injected
 * `execute(command)` function. Keeping this out of the React controller means
 * the command/parse/classify path is testable without a DOM, and the
 * controller stays a thin wrapper that only owns view state.
 */
export function createDockerClient(execute) {
  return {
    /** Containers plus images. A failed `docker ps` is the host-level
     *  failure worth reporting; a failed `docker images` only empties the
     *  images tab, so the container list still renders. */
    async list() {
      const [ps, imgs] = await Promise.all([
        execute(containersCommand()),
        execute(imagesCommand()),
      ]);
      if (ps.exitCode !== 0) {
        return { containers: [], images: [], failure: classifyDockerFailure(ps) };
      }
      return {
        containers: parseContainers(ps.stdout),
        images: imgs.exitCode === 0 ? parseImages(imgs.stdout) : [],
        failure: null,
      };
    },

    async diskUsage() {
      const result = await execute(systemDfCommand());
      if (result.exitCode !== 0) {
        return { rows: [], failure: classifyDockerFailure(result) };
      }
      return { rows: parseSystemDf(result.stdout), failure: null };
    },

    async inspect(id) {
      const result = await execute(inspectCommand(id));
      if (result.exitCode !== 0) {
        return { summary: null, raw: "", failure: classifyDockerFailure(result) };
      }
      return {
        summary: parseInspect(result.stdout),
        raw: result.stdout.trim(),
        failure: null,
      };
    },

    async action(action, id) {
      const result = await execute(dockerActionCommand(action, id));
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, failure: classifyDockerFailure(result) };
    },

    async logs(id, tail) {
      const result = await execute(containerLogsCommand(id, tail));
      return (result.stdout || result.stderr || "").trim() || "(no output)";
    },

    async pull(reference) {
      const result = await execute(pullCommand(reference));
      return result.exitCode === 0
        ? { ok: true, output: (result.stdout || "").trim() }
        : { ok: false, failure: classifyDockerFailure(result) };
    },

    async removeImage(id) {
      const result = await execute(removeImageCommand(id));
      return result.exitCode === 0
        ? { ok: true, output: (result.stdout || "").trim() }
        : { ok: false, failure: classifyDockerFailure(result) };
    },

    async pruneImages() {
      const result = await execute(pruneImagesCommand());
      return result.exitCode === 0
        ? { ok: true, output: (result.stdout || "").trim() }
        : { ok: false, failure: classifyDockerFailure(result) };
    },
  };
}
