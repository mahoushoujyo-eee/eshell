// Failure classification: turning a non-zero exit into something the panel can
// explain, and the wording for each case.
//
// The kinds are the failures a user can act on. The raw stderr is kept on
// every branch and shown under the sentence, because the exact message from
// xray or curl is usually the whole diagnosis.

const PATTERNS = [
  ["missing", /command not found|not found|No such file or directory/i],
  ["permission", /Permission denied|operation not permitted|read-only file system/i],
  ["sudo", /sudo: a password is required|sudo: no tty present|not in the sudoers file/i],
  ["invalidConfig", /failed to parse|invalid character|unexpected token|json: cannot unmarshal|Configuration OK/i],
  ["noConfig", /no such file or directory/i],
  ["network", /could not resolve host|connection timed out|operation timed out|network is unreachable/i],
  ["httpError", /HTTP\/[0-9.]+ [45][0-9][0-9]|The requested URL returned error/i],
  ["service", /Failed to (start|restart)|Unit .* not found|Job for .* failed/i],
];

export function classifyFailure(result) {
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
    message: detail || `the command exited with code ${result && result.exitCode}`,
  };
}

const DESCRIPTIONS = {
  missing: {
    text: "xray was not found on this host.",
    hint: "Install it, or set the binary path in the settings. The panel runs xray on the connected host over the session's SSH transport.",
  },
  permission: {
    text: "This user may not write that file.",
    hint: "The panel backs the config up next to it and replaces it by a rename, so it needs write access to the config AND its directory. Give the SSH user ownership of both, or allow `sudo -n` for the write and the restart.",
  },
  sudo: {
    text: "sudo needs a password, and this channel cannot answer a prompt.",
    hint: "Commands run on a non-interactive exec channel, so `sudo -n` fails instead of prompting. Grant the SSH user NOPASSWD, or use a config the user owns.",
  },
  invalidConfig: {
    text: "xray refused that configuration.",
    hint: "The previous config was restored. Check the message below — it names the field xray could not parse.",
  },
  noConfig: {
    text: "The config file was not found.",
    hint: "Set the config path in the settings, or make sure xray is installed with its config in place.",
  },
  network: {
    text: "The host could not reach the network.",
    hint: "The subscription is fetched by this host, not by your machine — a proxy or VPN that works on your laptop may not be in place here.",
  },
  httpError: {
    text: "The subscription server refused the request.",
    hint: "The URL may have expired, or the provider may reject the request. A 403 often means the user agent was refused; the panel sends `Mozilla/5.0`.",
  },
  service: {
    text: "The xray service did not come back.",
    hint: "The config was written and validated, so the service itself is the problem. Check `journalctl -u xray -n 50` on the host.",
  },
  error: {
    text: "The command failed.",
    hint: "The raw output is below.",
  },
};

export function describeFailure(failure) {
  const described = failure && DESCRIPTIONS[failure.kind];
  if (described) {
    return described;
  }
  return {
    text: (failure && failure.message) || "the command failed.",
    hint: (failure && failure.detail) || "",
  };
}
