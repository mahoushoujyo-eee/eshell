// Failure classification: turning a non-zero docker exit into something the
// panel can explain, and the wording for each case.
//
// The kinds are the failures a user can act on; anything else keeps docker's
// own message. The raw text is kept on every branch — the exact path in
// "permission denied while trying to connect to the Docker daemon socket at
// unix:///…" is what distinguishes the cases.

const PATTERNS = [
  ["missing", /command not found|not recognized as an internal|No such file or directory.*docker/i],
  ["composeMissing", /is not a docker command|unknown docker command|not a docker plugin/i],
  ["permission", /permission denied/i],
  [
    "daemon",
    /Cannot connect to the Docker daemon|Is the docker daemon running|docker daemon is not running|error during connect/i,
  ],
  ["sudo", /a terminal is required|sudo: no tty present|password is required/i],
  ["notFound", /No such container|No such image|No such volume|No such network|not found/i],
  [
    "conflict",
    /is in use|cannot remove a running container|has active endpoints|conflict|already in use/i,
  ],
  ["auth", /unauthorized|authentication required|denied: requested access|login/i],
];

export function classifyDockerFailure(result) {
  const stderr = String((result && result.stderr) ?? "");
  const stdout = String((result && result.stdout) ?? "");
  const combined = `${stderr}\n${stdout}`;
  const detail = stderr.trim() || stdout.trim();

  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(combined)) {
      return { kind, detail };
    }
  }
  return {
    kind: "error",
    detail,
    message: detail || `docker exited with code ${result && result.exitCode}`,
  };
}

const DESCRIPTIONS = {
  missing: {
    text: "docker was not found on the remote host.",
    hint: "Install docker, or check that it is on the PATH of a non-interactive SSH command. If it lives outside that PATH, set the CLI prefix to its absolute path.",
  },
  composeMissing: {
    text: "This docker installation has no `compose` subcommand.",
    hint: "Install the Compose v2 plugin (`docker-compose-plugin`). The standalone `docker-compose` v1 binary is a different command and is not used here.",
  },
  permission: {
    text: "Permission denied — the SSH user cannot reach the Docker socket.",
    // The group change only takes effect on a NEW connection: the supplementary
    // group list is read at login, and these commands run on a separate exec
    // channel that inherits the credentials from when the session was opened.
    // `newgrp` in the interactive shell does not help here.
    hint:
      "Run `sudo usermod -aG docker $USER` on the host, then reconnect this session — " +
      "an existing connection keeps the old group list. Or set the CLI prefix to `sudo -n docker`.",
  },
  daemon: {
    text: "Cannot connect to the Docker daemon on the remote host.",
    hint: "Start it with `sudo systemctl start docker`, or check whether this host runs a daemon at all.",
  },
  sudo: {
    text: "sudo needs a password, and this channel cannot answer a prompt.",
    hint: "Commands run on a non-interactive exec channel, so `sudo -n` fails instead of prompting. Grant the SSH user NOPASSWD for docker, or add them to the docker group.",
  },
  notFound: {
    text: "The object is gone — something else removed it.",
    hint: "Refresh the list; another client or a restart policy may have changed the host since it was read.",
  },
  conflict: {
    text: "docker refused the operation because the object is still in use.",
    hint: "Stop or disconnect what depends on it first, or use the force variant of the action.",
  },
  auth: {
    text: "The registry rejected the request.",
    hint: "Run `docker login` on the host in a terminal tab — this panel cannot answer a credential prompt.",
  },
};

export function describeDockerFailure(failure) {
  const described = failure && DESCRIPTIONS[failure.kind];
  if (described) {
    return described;
  }
  return {
    text: (failure && failure.message) || "docker command failed.",
    hint: (failure && failure.detail) || "",
  };
}
