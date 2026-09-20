import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { activate } from "../../../examples/k8s-plugin/index.js";
import manifest from "../../../examples/k8s-plugin/manifest.json";
import {
  applyCommand,
  cellTone,
  classifyFailure,
  cordonCommand,
  createKubectlClient,
  deleteCommand,
  describeCommand,
  describeFailure,
  drainCommand,
  emptyListMessage,
  eventsCommand,
  execCommand,
  explainCommand,
  getCommand,
  isSafeName,
  logsCommand,
  parseContainers,
  parseContexts,
  parseNameList,
  parseTable,
  parseVersion,
  portForwardCommand,
  resolveKind,
  rolloutCommand,
  rowTone,
  sanitizeBin,
  scaleCommand,
  suspendCommand,
  topCommand,
  triggerCronJobCommand,
  workloadLogsCommand,
  yamlCommand,
} from "../../../examples/k8s-plugin/kubectl.js";
import {
  filterRows,
  summarise,
  visibleColumns,
} from "../../../examples/k8s-plugin/controller/derive.js";

// Real `kubectl get pods -o wide` output: padded columns, a two-word header, a
// value containing a space, and `<none>` placeholders.
const PODS_WIDE = [
  "NAME                      READY   STATUS             RESTARTS      AGE   IP           NODE     NOMINATED NODE   READINESS GATES",
  "web-6f9c4b7d5-abcde       1/1     Running            0             3d    10.42.0.11   node-a   <none>           <none>",
  "api-77x9z                 0/1     CrashLoopBackOff   5 (20s ago)   1h    10.42.0.19   node-b   <none>           <none>",
  "migrate-once              0/1     Completed          0             2d    10.42.0.20   node-a   <none>           <none>",
].join("\n");

const NODES_WIDE = [
  "NAME     STATUS                     ROLES           AGE   VERSION",
  "node-a   Ready                      control-plane   90d   v1.30.2",
  "node-b   Ready,SchedulingDisabled   <none>          90d   v1.30.2",
].join("\n");

describe("kubectl command builders", () => {
  it("scopes every command with --context and the namespace flags", () => {
    const scope = { context: "prod", namespace: "shop" };
    expect(getCommand("pods", scope)).toBe("kubectl get pods --context 'prod' -n shop -o wide");
    expect(getCommand("pods", { allNamespaces: true })).toBe("kubectl get pods -A -o wide");
    // `-A` wins over `-n`: together they are a contradiction kubectl resolves
    // silently, so the builder does not emit both.
    expect(getCommand("pods", { namespace: "shop", allNamespaces: true })).toBe(
      "kubectl get pods -A -o wide",
    );
    // A cluster-scoped type gets no namespace flag at all.
    expect(getCommand("nodes", { ...scope, namespaced: false })).toBe(
      "kubectl get nodes --context 'prod' -o wide",
    );
  });

  // Regression: kubectl only knows `--context` / `--namespace` at root level.
  // `-A` is local to the listing subcommands, and an unknown root-level flag is
  // handed to its plugin resolver, which fails with
  // "flags cannot be placed before plugin name: -A". So no builder may put a
  // flag before the subcommand, and only a listing may pass `-A` at all.
  it("never puts a flag before the subcommand, and keeps -A to the listing verbs", () => {
    const scope = { context: "prod", namespace: "shop", allNamespaces: true };
    const listings = [getCommand("pods", scope), eventsCommand(scope), topCommand("pods", scope)];
    const singleObject = [
      describeCommand("pods", "web-1", scope),
      yamlCommand("pods", "web-1", scope),
      logsCommand("web-1", { tail: 10 }, scope),
      execCommand("web-1", "id", { shell: true }, scope),
      deleteCommand("pods", "web-1", scope),
      scaleCommand("deployments", "api", 1, scope),
      rolloutCommand("restart", "deployments", "api", scope),
      suspendCommand("nightly", true, scope),
      triggerCronJobCommand("nightly", "nightly-manual-1", scope),
      applyCommand("a: 1", {}, scope),
      portForwardCommand("pods", "web-1", "8080", scope),
    ];
    // Node verbs are cluster-scoped: no namespace flag of any kind.
    const clusterScoped = [cordonCommand("node-a", scope), drainCommand("node-a", scope)];

    for (const command of [...listings, ...singleObject, ...clusterScoped]) {
      expect(command.split(" ")[1].startsWith("-")).toBe(false);
      expect(command).not.toContain("kubectl -");
    }
    for (const command of listings) {
      expect(command).toContain(" -A");
    }
    for (const command of singleObject) {
      expect(command).not.toContain(" -A");
      // A single-object verb needs a real namespace, which the panel takes from
      // the row it was read from (see `client.withScope`).
      expect(command).toContain("-n shop");
    }
    for (const command of clusterScoped) {
      expect(command).not.toContain(" -A");
      expect(command).not.toContain("-n ");
    }
  });

  it("quotes a context name that carries slashes and colons", () => {
    const arn = "arn:aws:eks:eu-west-1:1234:cluster/prod";
    expect(getCommand("pods", { context: arn })).toBe(`kubectl get pods --context '${arn}' -o wide`);
    expect(() => getCommand("pods", { context: "prod; rm -rf /" })).toThrow(/context name/);
  });

  it("honours a sanitised CLI prefix and falls back for anything else", () => {
    expect(sanitizeBin("k3s kubectl")).toBe("k3s kubectl");
    expect(sanitizeBin("microk8s kubectl")).toBe("microk8s kubectl");
    expect(sanitizeBin("env KUBECONFIG=/etc/k8s.conf kubectl")).toBe(
      "env KUBECONFIG=/etc/k8s.conf kubectl",
    );
    for (const bad of ["kubectl; rm -rf /", "$(id)", "kubectl && curl x", "`id`"]) {
      expect(sanitizeBin(bad)).toBe("kubectl");
    }
    expect(getCommand("pods", { bin: "k3s kubectl" })).toMatch(/^k3s kubectl get pods/);
  });

  it("refuses names, namespaces and types that could carry shell syntax", () => {
    for (const bad of ["web; rm -rf /", "$(whoami)", "web && curl x", "-rm", "web pod", ""]) {
      expect(isSafeName(bad)).toBe(false);
      expect(() => describeCommand("pods", bad)).toThrow();
      expect(() => deleteCommand("pods", bad)).toThrow();
    }
    expect(() => getCommand("pods", { namespace: "Shop" })).toThrow(/namespace/);
    expect(() => getCommand("pods; id", {})).toThrow(/resource type/);
    // Names kubectl itself prints stay legal, including RBAC's `system:` form.
    expect(describeCommand("pods", "web-6f9c4b7d5-abcde")).toBe(
      "kubectl describe pods/web-6f9c4b7d5-abcde",
    );
    expect(describeCommand("clusterroles", "system:node")).toContain("clusterroles/system:node");
  });

  it("builds the read commands", () => {
    expect(yamlCommand("deployments", "api", { namespace: "shop" })).toBe(
      "kubectl get deployments/api -n shop -o yaml",
    );
    expect(topCommand("nodes", { namespace: "shop" })).toBe("kubectl top nodes");
    expect(topCommand("nodes", { name: "node-a" })).toBe("kubectl top nodes node-a");
    expect(topCommand("pods", { namespace: "shop", containers: true })).toBe(
      "kubectl top pods -n shop --containers",
    );
    expect(() => topCommand("nodes", { name: "node-a; id" })).toThrow(/unexpected name/);
    expect(explainCommand("ingresses")).toBe("kubectl explain ingresses --recursive");
  });

  it("folds stderr into stdout for logs and honours every option", () => {
    expect(logsCommand("web-1", { tail: 100 })).toBe("kubectl logs pod/web-1 --tail=100 2>&1");
    expect(
      logsCommand(
        "web-1",
        { tail: 50, container: "app", since: "15m", timestamps: true, previous: true },
        { namespace: "shop" },
      ),
    ).toBe(
      "kubectl logs pod/web-1 -n shop --tail=50 -c app --since=15m --timestamps --previous 2>&1",
    );
    // A workload fans out over its pods, which is what --prefix is for.
    expect(workloadLogsCommand("deployments", "api", { tail: 10 })).toBe(
      "kubectl logs deployments/api --tail=10 --all-containers --prefix 2>&1",
    );
    expect(() => logsCommand("web-1", { since: "$(date)" })).toThrow(/duration/);
    expect(() => logsCommand("web-1", { container: "APP" })).toThrow(/container name/);
  });

  it("runs exec either through sh -c or as argv after --", () => {
    expect(execCommand("web-1", "ls -al /tmp | head", { shell: true })).toBe(
      "kubectl exec pod/web-1 -- sh -c 'ls -al /tmp | head' 2>&1",
    );
    expect(execCommand("web-1", "cat /etc/hosts", { container: "app" })).toBe(
      "kubectl exec pod/web-1 -c app -- 'cat' '/etc/hosts' 2>&1",
    );
    expect(() => execCommand("web-1", "")).toThrow(/required/);
    expect(() => execCommand("web-1", "echo 'unbalanced")).toThrow(/unbalanced quote/);
  });

  it("builds the write commands, with the flags kubectl actually needs", () => {
    expect(scaleCommand("deployments", "api", 3, { namespace: "shop" })).toBe(
      "kubectl scale deployments/api -n shop --replicas=3",
    );
    expect(scaleCommand("deployments", "api", 0)).toContain("--replicas=0");
    expect(() => scaleCommand("pods", "web-1", 2)).toThrow(/cannot be scaled/);
    expect(() => scaleCommand("deployments", "api", -1)).toThrow(/between 0 and 10000/);
    expect(() => scaleCommand("deployments", "api", 1.5)).toThrow(/integer/);

    // `rollout status` without a timeout never returns on a stuck rollout.
    expect(rolloutCommand("status", "deployments", "api")).toBe(
      "kubectl rollout status deployments/api --timeout=60s",
    );
    expect(rolloutCommand("undo", "deployments", "api", { revision: 3 })).toBe(
      "kubectl rollout undo deployments/api --to-revision=3",
    );
    expect(() => rolloutCommand("nuke", "deployments", "api")).toThrow(/unsupported/);

    // `--force` is only honoured together with a zero grace period.
    expect(deleteCommand("pods", "web-1", { force: true })).toBe(
      "kubectl delete pods/web-1 --force --grace-period=0",
    );
    expect(deleteCommand("pods", "web-1", { gracePeriod: 5 })).toBe(
      "kubectl delete pods/web-1 --grace-period=5",
    );

    expect(suspendCommand("nightly", true)).toBe(
      `kubectl patch cronjob/nightly -p '{"spec":{"suspend":true}}'`,
    );
    expect(triggerCronJobCommand("nightly", "nightly-manual-1")).toBe(
      "kubectl create job nightly-manual-1 --from=cronjob/nightly",
    );
    expect(cordonCommand("node-a")).toBe("kubectl cordon node-a");
    // Without these two flags, drain refuses on any real node.
    expect(drainCommand("node-a")).toBe(
      "kubectl drain node-a --ignore-daemonsets --delete-emptydir-data --timeout=120s",
    );
    expect(drainCommand("node-a", { force: true })).toContain("--force");
  });

  it("pipes an apply through a quoted heredoc and guards the delimiter", () => {
    const command = applyCommand("apiVersion: v1\nkind: ConfigMap\n", {}, { namespace: "shop" });
    expect(command).toBe(
      [
        "kubectl apply -n shop -f - <<'ESHELL_K8S_MANIFEST'",
        "apiVersion: v1",
        "kind: ConfigMap",
        "ESHELL_K8S_MANIFEST",
      ].join("\n"),
    );
    expect(applyCommand("a: 1", { dryRun: true })).toContain("--dry-run=server");
    expect(() => applyCommand("   ")).toThrow(/empty/);
    // A body that contains the delimiter would end the document early.
    expect(() => applyCommand("a: 1\nESHELL_K8S_MANIFEST\nb: 2")).toThrow(/must not contain/);
  });

  it("builds a port-forward line without running it", () => {
    expect(portForwardCommand("pods", "web-1", "8080:80", { namespace: "shop" })).toBe(
      "kubectl port-forward pods/web-1 8080:80 -n shop",
    );
    expect(() => portForwardCommand("pods", "web-1", "8080:80; id")).toThrow(/port mapping/);
  });
});

describe("kubectl table parser", () => {
  it("reads columns by header offset, keeping values that contain spaces", () => {
    const { columns, rows } = parseTable(PODS_WIDE);
    expect(columns).toEqual([
      "NAME",
      "READY",
      "STATUS",
      "RESTARTS",
      "AGE",
      "IP",
      "NODE",
      "NOMINATED NODE",
      "READINESS GATES",
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0].byName).toMatchObject({
      NAME: "web-6f9c4b7d5-abcde",
      READY: "1/1",
      STATUS: "Running",
      RESTARTS: "0",
      NODE: "node-a",
    });
    // A one-space value must not be torn apart by column detection.
    expect(rows[1].byName.RESTARTS).toBe("5 (20s ago)");
    expect(rows[1].byName.STATUS).toBe("CrashLoopBackOff");
    expect(rows[0].name).toBe("web-6f9c4b7d5-abcde");
  });

  it("keeps a NAMESPACE column and uses it in the row key", () => {
    const { rows } = parseTable(
      [
        "NAMESPACE     NAME      READY   STATUS    RESTARTS   AGE",
        "kube-system   coredns   1/1     Running   0          90d",
      ].join("\n"),
    );
    expect(rows[0].namespace).toBe("kube-system");
    expect(rows[0].name).toBe("coredns");
    expect(rows[0].key).toContain("kube-system/coredns");
  });

  it("returns nothing for empty output", () => {
    expect(parseTable("")).toEqual({ columns: [], rows: [] });
    expect(parseTable("   \n")).toEqual({ columns: [], rows: [] });
  });

  it("reads -o name lists, contexts, containers and the version", () => {
    expect(parseNameList("namespace/default\nnamespace/kube-system")).toEqual([
      "default",
      "kube-system",
    ]);
    expect(parseContexts("prod\ndev\n")).toEqual(["dev", "prod"]);
    expect(parseContainers("init/istio-init\nmain/app\nmain/sidecar")).toEqual([
      { name: "istio-init", init: true },
      { name: "app", init: false },
      { name: "sidecar", init: false },
    ]);
    const version = parseVersion(
      JSON.stringify({
        clientVersion: { gitVersion: "v1.30.2", platform: "linux/amd64" },
        serverVersion: { gitVersion: "v1.29.6" },
      }),
    );
    expect(version).toMatchObject({ clientVersion: "v1.30.2", serverVersion: "v1.29.6", live: true });
    // A client-only version (API server unreachable) is still readable.
    expect(parseVersion(JSON.stringify({ clientVersion: { gitVersion: "v1.30.2" } })).live).toBe(
      false,
    );
    expect(parseVersion("not json")).toBeNull();
  });
});

describe("cell and row status", () => {
  it("reads a fraction, a restart count and a phase", () => {
    expect(cellTone("READY", "1/1")).toBe("success");
    expect(cellTone("READY", "0/1")).toBe("warning");
    expect(cellTone("RESTARTS", "0")).toBeNull();
    expect(cellTone("RESTARTS", "2")).toBe("warning");
    expect(cellTone("RESTARTS", "5 (20s ago)")).toBe("danger");
    expect(cellTone("STATUS", "Running")).toBe("success");
    expect(cellTone("STATUS", "Completed")).toBe("success");
    expect(cellTone("STATUS", "Pending")).toBe("warning");
    expect(cellTone("STATUS", "Terminating")).toBe("warning");
    expect(cellTone("STATUS", "CrashLoopBackOff")).toBe("danger");
    expect(cellTone("STATUS", "ImagePullBackOff")).toBe("danger");
    // "NotReady" contains "Ready", so the bad list has to be checked first.
    expect(cellTone("STATUS", "NotReady")).toBe("danger");
    expect(cellTone("STATUS", "Ready,SchedulingDisabled")).toBe("warning");
    expect(cellTone("IP", "10.42.0.11")).toBeNull();
  });

  it("gives a row the worst tone any of its cells has", () => {
    const { rows } = parseTable(PODS_WIDE);
    expect(rowTone(rows[0])).toBe("success");
    expect(rowTone(rows[1])).toBe("danger");
    const nodes = parseTable(NODES_WIDE);
    expect(rowTone(nodes.rows[0])).toBe("success");
    expect(rowTone(nodes.rows[1])).toBe("warning");
  });
});

describe("controller derivations", () => {
  it("hides the -o wide columns that are almost always empty", () => {
    const { columns } = parseTable(PODS_WIDE);
    expect(visibleColumns(columns, { hideNoisy: true })).not.toContain("NOMINATED NODE");
    expect(visibleColumns(columns, { hideNoisy: true })).toContain("NODE");
    expect(visibleColumns(columns, { hideNoisy: false })).toContain("READINESS GATES");
  });

  it("filters rows across every cell", () => {
    const { rows } = parseTable(PODS_WIDE);
    expect(filterRows(rows, "node-b")).toHaveLength(1);
    expect(filterRows(rows, "crashloop")).toHaveLength(1);
    expect(filterRows(rows, "")).toHaveLength(3);
    expect(filterRows(rows, "nothing")).toHaveLength(0);
  });

  it("summarises the health of a listing", () => {
    const { rows } = parseTable(PODS_WIDE);
    expect(summarise(rows)).toEqual({ total: 3, success: 1, warning: 1, danger: 1 });
  });
});

describe("resource kinds", () => {
  it("knows the built-in types and falls back for anything else", () => {
    expect(resolveKind("pods")).toMatchObject({ kind: "pods", namespaced: true });
    expect(resolveKind("nodes")).toMatchObject({ namespaced: false, noDelete: true });
    const custom = resolveKind("crontabs.stable.example.com");
    expect(custom).toMatchObject({ kind: "crontabs.stable.example.com", custom: true });
    expect(custom.actions).toEqual([]);
  });
});

describe("kubectl failure classification", () => {
  it("classifies the failures a user can act on", () => {
    const cases = [
      ["bash: kubectl: command not found", "missing"],
      ["error: no configuration has been provided, try setting KUBERNETES_MASTER", "noConfig"],
      ["error: no context exists with the name: staging", "contextMissing"],
      ["Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout", "unreachable"],
      ["error: You must be logged in to the server (Unauthorized)", "unauthorized"],
      [
        'Error from server (Forbidden): pods is forbidden: User "system:serviceaccount:ci:runner" cannot list resource "pods"',
        "forbidden",
      ],
      ['Error from server (NotFound): pods "web-1" not found', "notFound"],
      ["error: Metrics API not available", "metrics"],
      ["error validating data: ValidationError(ConfigMap): unknown field", "invalid"],
      ['Error from server (AlreadyExists): jobs.batch "nightly" already exists', "alreadyExists"],
      ["error: timed out waiting for the condition", "timeout"],
    ];
    for (const [stderr, kind] of cases) {
      expect(classifyFailure({ stderr, exitCode: 1 }).kind).toBe(kind);
    }
    expect(classifyFailure({ stderr: "something else", exitCode: 1 })).toEqual({
      kind: "error",
      detail: "something else",
      message: "something else",
    });
  });

  it("keeps the raw stderr and names the fix", () => {
    const forbidden = classifyFailure({
      stderr:
        'Error from server (Forbidden): pods is forbidden: User "system:serviceaccount:ci:runner" cannot list resource "pods"',
      exitCode: 1,
    });
    expect(forbidden.detail).toContain("system:serviceaccount:ci:runner");
    expect(describeFailure(forbidden).text).toMatch(/RBAC/);
    expect(describeFailure({ kind: "missing" }).hint).toMatch(/k3s kubectl/);
    expect(describeFailure({ kind: "noConfig" }).hint).toMatch(/KUBECONFIG/);
    expect(describeFailure({ kind: "metrics" }).hint).toMatch(/metrics-server/);
    expect(describeFailure(null).text).toMatch(/failed/);
  });

  it("treats 'No resources found' as an empty list, not a failure", () => {
    expect(emptyListMessage({ stderr: "No resources found in shop namespace.\n" })).toBe(
      "No resources found in shop namespace.",
    );
    expect(emptyListMessage({ stderr: "" })).toBe("");
  });
});

describe("kubectl client", () => {
  const client = (execute, options) => createKubectlClient(execute, options);

  it("parses a listing and reports a failure instead of an empty table", async () => {
    const ok = client(async () => ({ stdout: PODS_WIDE, stderr: "", exitCode: 0 }));
    const listed = await ok.list("pods");
    expect(listed.ok).toBe(true);
    expect(listed.rows).toHaveLength(3);

    const denied = client(async () => ({
      stdout: "",
      stderr: 'Error from server (Forbidden): pods is forbidden: User "x" cannot list resource "pods"',
      exitCode: 1,
    }));
    const failed = await denied.list("pods");
    expect(failed.ok).toBe(false);
    expect(failed.rows).toEqual([]);
    expect(failed.failure.kind).toBe("forbidden");
  });

  it("carries the empty-list note out of stderr", async () => {
    const empty = client(async () => ({
      stdout: "",
      stderr: "No resources found in shop namespace.",
      exitCode: 0,
    }));
    const listed = await empty.list("pods");
    expect(listed.ok).toBe(true);
    expect(listed.rows).toEqual([]);
    expect(listed.note).toMatch(/No resources found/);
  });

  it("threads the scope through every command", async () => {
    const seen = [];
    const scoped = client(
      async (command) => {
        seen.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      { bin: "k3s kubectl", context: "prod", namespace: "shop" },
    );
    await scoped.list("pods");
    await scoped.describe("pods", "web-1");
    expect(seen[0]).toBe("k3s kubectl get pods --context 'prod' -n shop -o wide");
    expect(seen[1]).toBe("k3s kubectl describe pods/web-1 --context 'prod' -n shop");
  });

  it("overrides the namespace for one row through withScope", async () => {
    const seen = [];
    const base = client(
      async (command) => {
        seen.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      { allNamespaces: true },
    );
    // A row read with `-A` lives in its own namespace; the command has to say so.
    await base.withScope({ namespace: "kube-system", allNamespaces: false }).describe("pods", "coredns");
    expect(seen[0]).toBe("kubectl describe pods/coredns -n kube-system");
  });

  it("resolves with ok:false rather than rejecting when the cluster says no", async () => {
    const broken = client(async () => ({
      stdout: "",
      stderr: 'Error from server (NotFound): pods "web-1" not found',
      exitCode: 1,
    }));
    const result = await broken.remove("pods", "web-1");
    expect(result.ok).toBe(false);
    expect(result.failure.kind).toBe("notFound");
    expect(result.command).toBe("kubectl delete pods/web-1");
  });

  it("rejects for a value that failed validation", async () => {
    const noop = client(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await expect(noop.remove("pods", "web-1; rm -rf /")).rejects.toThrow(/unexpected name/);
    await expect(noop.scale("pods", "web-1", 2)).rejects.toThrow(/cannot be scaled/);
    await expect(noop.apply("a: 1\nESHELL_K8S_MANIFEST")).rejects.toThrow(/must not contain/);
  });

  it("merges both streams for logs and keeps a placeholder when silent", async () => {
    const withOutput = client(async () => ({
      stdout: "serving on :8080\n",
      stderr: "",
      exitCode: 0,
    }));
    expect((await withOutput.logs("web-1", { tail: 10 })).text).toBe("serving on :8080");
    const silent = client(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    expect((await silent.logs("web-1", { tail: 10 })).text).toBe("(no output)");
  });

  it("reads the kubeconfig contexts and the current one together", async () => {
    const configured = client(async (command) =>
      command.includes("current-context")
        ? { stdout: "prod\n", stderr: "", exitCode: 0 }
        : { stdout: "dev\nprod\n", stderr: "", exitCode: 0 },
    );
    const result = await configured.contexts();
    expect(result.contexts).toEqual(["dev", "prod"]);
    expect(result.current).toBe("prod");
  });
});

// Mirrors the host contract: one controller hook, panels rendered with
// `{ api, context, controller }`, and a facade whose `sessions.execute` is the
// only backend the plugin may reach.
function fixture() {
  const panels = [];
  const toolbars = [];
  const disposers = [];
  let controllerHook;
  const register = (accept) =>
    vi.fn((item) => {
      accept(item);
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    });
  const execute = vi.fn(async () => ({ stdout: PODS_WIDE, stderr: "", exitCode: 0 }));
  const store = new Map();
  const api = {
    react: React,
    meta: { pluginId: manifest.id, apiVersion: 1 },
    sessions: { execute },
    storage: {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      remove: (key) => store.delete(key),
    },
    ui: {
      registerPanel: register((panel) => panels.push(panel)),
      registerToolbar: register((item) => toolbars.push(item)),
      registerController: register((hook) => {
        controllerHook = hook;
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const parsed = parseTable(PODS_WIDE);
  return {
    api,
    panels,
    toolbars,
    disposers,
    execute,
    get controllerHook() {
      return controllerHook;
    },
    // The panel renders from an explicit controller snapshot: this suite has no
    // DOM, so effects never run. The async paths are covered against the client
    // above; these renders assert the static states.
    render(overrides = {}, context = { activeSessionId: "s1", activeSession: { configName: "bastion" } }) {
      const controller = {
        locale: "en",
        hasSession: Boolean(context.activeSessionId),
        hostLabel: (context.activeSession && context.activeSession.configName) || "",
        bin: "kubectl",
        binDraft: "kubectl",
        setBinDraft() {},
        applyBin() {},
        resetBin() {},
        kindKey: "pods",
        setKindKey() {},
        customKind: "",
        setCustomKind() {},
        descriptor: resolveKind("pods"),
        context: "",
        setContext() {},
        namespace: "",
        setNamespace() {},
        allNamespaces: false,
        setAllNamespaces() {},
        contexts: ["dev", "prod"],
        currentContext: "prod",
        namespaces: ["default", "kube-system"],
        version: { clientVersion: "v1.30.2", serverVersion: "v1.29.6", live: true },
        columns: visibleColumns(parsed.columns, { hideNoisy: true }),
        rows: parsed.rows,
        allRows: parsed.rows,
        summary: summarise(parsed.rows),
        note: "",
        loading: false,
        failure: null,
        query: "",
        setQuery() {},
        onlyProblems: false,
        setOnlyProblems() {},
        hideNoisy: true,
        setHideNoisy() {},
        sortByAge: false,
        setSortByAge() {},
        autoRefresh: 0,
        setAutoRefresh() {},
        logTail: 200,
        setLogTail() {},
        selection: new Set(),
        selectedRows: [],
        toggleSelect() {},
        toggleSelectAll() {},
        clearSelection() {},
        notice: null,
        dismissNotice() {},
        say() {},
        isBusy: () => false,
        anyBusy: false,
        refresh() {},
        sheet: null,
        closeSheet() {},
        modal: null,
        openModal() {},
        closeModal() {},
        confirm: null,
        askConfirm() {},
        closeConfirm() {},
        runConfirm() {},
        openLogs() {},
        reloadLogs() {},
        openText() {},
        openTable() {},
        openExec() {},
        patchExec() {},
        runExec() {},
        execState: null,
        logContainer: "",
        logContainers: [],
        logSince: "",
        setLogSince() {},
        logTimestamps: false,
        setLogTimestamps() {},
        logPrevious: false,
        setLogPrevious() {},
        setLogContainer() {},
        logFollow: false,
        setLogFollow() {},
        logFilter: "",
        setLogFilter() {},
        logWrap: true,
        setLogWrap() {},
        client: {
          portForwardLine: () => "kubectl port-forward pods/web-1 8080:80",
          top: async () => ({ ok: true, columns: [], rows: [] }),
        },
        clientFor: () => ({
          portForwardLine: () => "kubectl port-forward pods/web-1 8080:80",
        }),
        task() {},
        bulkTask() {},
        ...overrides,
      };
      return renderToStaticMarkup(panels.at(-1).render({ api, context, controller }));
    },
  };
}

describe("kubernetes plugin activation", () => {
  it("registers a panel, a toolbar button and exactly one controller", async () => {
    const host = fixture();
    const dispose = await activate(host.api);
    expect(manifest.builtin).toBe(false);
    expect(manifest.apiVersion).toBe(1);
    expect(host.panels).toHaveLength(1);
    expect(host.panels[0].id).toBe(manifest.contributes.panels[0].id);
    expect(host.panels[0].defaultVisible).toBeUndefined();
    expect(host.toolbars[0].panelId).toBe(host.panels[0].id);
    expect(host.toolbars[0].icon).toMatch(/icon\.svg$/);
    expect(typeof host.controllerHook).toBe("function");
    dispose();
    for (const unregister of host.disposers) {
      expect(unregister).toHaveBeenCalledOnce();
    }
  });

  it("asks for a session instead of running kubectl without one", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({}, { activeSessionId: null, activeSession: null });
    expect(html).toContain("No active session");
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("renders the listing with kubectl's own columns", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render();
    expect(html).toContain("bastion");
    expect(html).toContain("v1.29.6");
    // Columns come from the output, not from the plugin.
    expect(html).toContain("READY");
    expect(html).toContain("RESTARTS");
    expect(html).toContain("web-6f9c4b7d5-abcde");
    expect(html).toContain("CrashLoopBackOff");
    // The noisy `-o wide` columns are hidden by default.
    expect(html).not.toContain("NOMINATED NODE");
    // A failing row is coloured, not just printed.
    expect(html).toContain("text-danger");
  });

  it("offers the context and namespace pickers from the kubeconfig", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render();
    expect(html).toContain("current: prod");
    expect(html).toContain("all namespaces (-A)");
    expect(html).toContain("kube-system");
  });

  it("shows the health summary and the type tabs", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render();
    expect(html).toContain("Deployments");
    expect(html).toContain("CronJobs");
    expect(html).toContain('title="kubectl get nodes"');
    expect(html).toContain("problems only");
    expect(html).toContain("Apply YAML…");
  });

  it("explains an unusable host instead of showing a raw error", async () => {
    const host = fixture();
    await activate(host.api);
    const denied = host.render({
      failure: {
        kind: "forbidden",
        detail: 'pods is forbidden: User "system:serviceaccount:ci:runner" cannot list resource "pods"',
      },
    });
    expect(denied).toContain("RBAC denied this request");
    expect(denied).toContain("system:serviceaccount:ci:runner");
    expect(denied).toContain("Retry");

    const noConfig = host.render({ failure: { kind: "noConfig" } });
    expect(noConfig).toContain("no kubeconfig");
    expect(noConfig).toContain("KUBECONFIG");
  });

  it("renders the empty state with kubectl's own message", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ rows: [], note: "No resources found in shop namespace." });
    expect(html).toContain("No resources found in shop namespace.");
  });

  it("renders the log sheet with its kubectl logs options", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({
      sheet: {
        kind: "logs",
        token: "t",
        target: { pod: "web-1", title: "web-1" },
        text: "serving on :8080",
        pending: false,
      },
      logContainers: [
        { name: "app", init: false },
        { name: "istio-init", init: true },
      ],
    });
    expect(html).toContain("Logs · web-1");
    expect(html).toContain("serving on :8080");
    expect(html).toContain("--tail=200");
    expect(html).toContain("istio-init (init)");
    expect(html).toContain("previous");
    expect(html).toContain("follow");
  });

  it("renders the scale dialog seeded from the row", async () => {
    const host = fixture();
    await activate(host.api);
    const parsed = parseTable(
      ["NAME   READY   UP-TO-DATE   AVAILABLE   AGE", "api    2/3     3            2           5d"].join(
        "\n",
      ),
    );
    const html = host.render({
      descriptor: resolveKind("deployments"),
      modal: { kind: "scale", row: parsed.rows[0] },
    });
    expect(html).toContain("Scale api");
    expect(html).toContain("kubectl scale deployments/api --replicas=2");
    expect(html).toContain("Currently 2/3");
  });

  it("renders the apply dialog and says what it will not do", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({ modal: { kind: "apply" } });
    expect(html).toContain("Apply a manifest");
    expect(html).toContain("Dry run");
    expect(html).toContain("--prune is never used");
  });

  it("hands the port-forward command over instead of running it", async () => {
    const host = fixture();
    await activate(host.api);
    const parsed = parseTable(PODS_WIDE);
    const html = host.render({ modal: { kind: "portForward", row: parsed.rows[0] } });
    expect(html).toContain("kubectl port-forward pods/web-1 8080:80");
    expect(html).toContain("Copy command");
  });

  it("renders a destructive confirmation with the exact command", async () => {
    const host = fixture();
    await activate(host.api);
    const html = host.render({
      confirm: {
        title: "Delete web-1?",
        command: "kubectl delete pods/web-1",
        confirmLabel: "Delete",
        tone: "danger",
        body: "There is no undo. A controller may recreate it immediately.",
        run() {},
      },
    });
    expect(html).toContain("Delete web-1?");
    expect(html).toContain("kubectl delete pods/web-1");
    expect(html).toContain("no undo");
  });

  it("renders the bulk bar only when rows are ticked", async () => {
    const host = fixture();
    await activate(host.api);
    const parsed = parseTable(PODS_WIDE);
    expect(host.render()).not.toContain("1 selected");
    const html = host.render({
      selection: new Set([parsed.rows[0].key]),
      selectedRows: [parsed.rows[0]],
    });
    expect(html).toContain("1 selected");
    expect(html).toContain("Delete selected");
  });

  it("shows a notice above the listing", async () => {
    const host = fixture();
    await activate(host.api);
    expect(host.render({ notice: { tone: "success", text: "kubectl scale api" } })).toContain(
      "kubectl scale api",
    );
  });
});
