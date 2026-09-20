// Failure classification: turning a non-zero kubectl exit into something the
// panel can explain, and the wording for each case.
//
// The kinds are the failures a user can act on. The raw stderr is kept on every
// branch and shown under the sentence — with RBAC, the message names the verb,
// the resource and the ServiceAccount, and that detail is the whole diagnosis.

const PATTERNS = [
  ["missing", /command not found|not recognized as an internal|No such file or directory.*kubectl/i],
  [
    "noConfig",
    /no configuration has been provided|Missing or incomplete configuration|connection to the server localhost:8080 was refused|invalid configuration/i,
  ],
  ["contextMissing", /no context exists with the name|context .* does not exist/i],
  [
    "unreachable",
    /Unable to connect to the server|dial tcp|i\/o timeout|no such host|TLS handshake timeout|connection refused/i,
  ],
  ["unauthorized", /Unauthorized|You must be logged in|certificate has expired|x509/i],
  ["forbidden", /Forbidden|is forbidden: User|cannot list resource|cannot get resource/i],
  ["notFound", /NotFound|not found|doesn't have a resource type|server doesn't have a resource/i],
  ["metrics", /Metrics API not available|metrics-server|metrics not available/i],
  ["invalid", /error validating data|Invalid value|BadRequest|error parsing|cannot unmarshal/i],
  ["alreadyExists", /AlreadyExists|already exists/i],
  ["conflict", /the object has been modified|Conflict/i],
  ["timeout", /timed out waiting for the condition|context deadline exceeded/i],
  ["sudo", /a terminal is required|sudo: no tty present|password is required/i],
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
    message: detail || `kubectl exited with code ${result && result.exitCode}`,
  };
}

const DESCRIPTIONS = {
  missing: {
    text: "kubectl was not found on the remote host.",
    hint: "Install it, or check that it is on the PATH of a non-interactive SSH command. For k3s or MicroK8s, set the CLI prefix to `k3s kubectl` or `microk8s kubectl`.",
  },
  noConfig: {
    text: "kubectl has no kubeconfig to work with.",
    // These commands run on their own exec channel, which is not a login shell
    // on every host, so a KUBECONFIG exported from ~/.bashrc may be absent.
    hint: "Check that ~/.kube/config exists for the SSH user. A KUBECONFIG set in ~/.bashrc may not reach a non-interactive command — set the CLI prefix to `env KUBECONFIG=/path/to/config kubectl` instead.",
  },
  contextMissing: {
    text: "That context is not in the host's kubeconfig.",
    hint: "Pick another context in the header, or clear it to use the kubeconfig's current context.",
  },
  unreachable: {
    text: "The API server did not answer.",
    hint: "Check that the cluster is up and reachable from this host — the panel runs kubectl there, not locally, so a VPN on your machine does not apply.",
  },
  unauthorized: {
    text: "The API server rejected the credentials.",
    hint: "The kubeconfig's token or client certificate may have expired. Refresh it on the host; this panel cannot answer an interactive auth plugin.",
  },
  forbidden: {
    text: "RBAC denied this request.",
    hint: "The message below names the user, the verb and the resource. Grant it, or switch to a context with the rights you need.",
  },
  notFound: {
    text: "The object or resource type does not exist.",
    hint: "It may have been deleted, or it may live in another namespace. For a custom type, check the exact plural name with `kubectl api-resources`.",
  },
  metrics: {
    text: "`kubectl top` needs metrics-server, which this cluster does not have.",
    hint: "Install metrics-server, or read CPU and memory from the Nodes tab instead.",
  },
  invalid: {
    text: "The API server rejected the document.",
    hint: "Run the apply again with dry-run to see which field it objects to.",
  },
  alreadyExists: {
    text: "An object with that name already exists.",
    hint: "Pick another name — or use apply, which updates instead of creating.",
  },
  conflict: {
    text: "Something else changed the object first.",
    hint: "Refresh and try again; the panel does not overwrite a newer version it has not read.",
  },
  timeout: {
    text: "The command gave up waiting.",
    hint: "A rollout that never becomes ready will time out here. Check the pods and their events.",
  },
  sudo: {
    text: "sudo needs a password, and this channel cannot answer a prompt.",
    hint: "Commands run on a non-interactive exec channel, so `sudo -n` fails instead of prompting. Grant the SSH user NOPASSWD, or read the kubeconfig as that user.",
  },
};

export function describeFailure(failure) {
  const described = failure && DESCRIPTIONS[failure.kind];
  if (described) {
    return described;
  }
  return {
    text: (failure && failure.message) || "kubectl command failed.",
    hint: (failure && failure.detail) || "",
  };
}

/**
 * `kubectl get` writes "No resources found…" to stderr and still exits 0. That
 * is an empty list, not a failure, and the sentence is worth showing as a hint.
 */
export const emptyListMessage = (result) => {
  const stderr = String((result && result.stderr) || "").trim();
  return /No resources found/i.test(stderr) ? stderr : "";
};
