# Kubernetes Plugin

A kubectl client for eShell: any resource type, in any namespace, on any context
the **active SSH session's host** can reach.

## Scope: kubectl on the remote host

The plugin facade gives a plugin `sessions.execute` and nothing else — no local
process spawn and no HTTP client for the API server. So this drives the `kubectl`
binary *on the connected host*, against that host's kubeconfig: a bastion, a
control-plane node, a jump box. Your laptop's kubeconfig and VPN are not
involved.

Context and namespace are passed as `--context` and `-n` on **every** command.
The panel deliberately never runs `kubectl config use-context`: that rewrites the
host's kubeconfig and would change what every other user and script on that
machine sees.

Three things the CLI does that an exec channel cannot, and what the panel does
instead:

| CLI | Why not | Instead |
| --- | --- | --- |
| `kubectl exec -it` | no TTY on the channel | `kubectl exec` without a TTY: one command, its output, its exit code |
| `kubectl logs -f`, `get -w` | a stream cannot be interrupted from here | a **follow** toggle that re-reads every 3s |
| `kubectl port-forward` | holds the connection open until interrupted | the panel builds the command and hands it to you for a terminal tab |

## Install

**Settings → Plugins → Install from folder…**, pick this directory. It is copied
to `<storage-root>/extensions/com.example.kubernetes/` and becomes live without a
restart. Or copy it there by hand and restart; for the usual
`npm run tauri -- dev` run that root is `src-tauri/.eshell-data`.

The panel starts hidden — panels are opt-in. Open it from the Kubernetes button
in the toolbar's Panels section. See the
[plugin development guide](../../docs/guides/features/plugin_development.md) for
the storage root, `state.json`, and the trust model.

## What it does

**Any resource type.** Tabs cover Pods, Deployments, StatefulSets, DaemonSets,
ReplicaSets, Services, Ingresses, Jobs, CronJobs, ConfigMaps, Secrets, PVCs, PVs,
Nodes, Namespaces and Events; the **other type…** box takes anything else,
including CRDs (`crontabs.stable.example.com`). Every listing is
`kubectl get <kind> -o wide`, rendered from **kubectl's own columns** — which is
why a CRD with server-defined printer columns works with no per-type code.

**Status you can read at a glance.** The cells that carry meaning are coloured
from their text: `READY 2/3` amber, `CrashLoopBackOff` red, `Completed` green,
`Ready,SchedulingDisabled` amber, `RESTARTS 5 (20s ago)` red. The row's dot is
the worst opinion any of its cells has, and the toolbar shows how many rows are
healthy / pending / failing plus a **problems only** filter.

**Scope pickers.** Context from `kubectl config get-contexts`, namespace from
`kubectl get namespaces`, plus `--all-namespaces`. In `-A` mode a row's action
runs with **that row's** namespace, not the panel's.

**Per row**, by type:

- Pods — logs (container picker incl. init containers, `--tail`, `--since`, `-t`,
  `--previous`, follow, line filter), exec, port-forward command, describe, YAML,
  events, delete, force delete
- Deployments / StatefulSets / ReplicaSets — scale (with a separate confirmation
  for scale-to-zero), rollout restart / status / history / undo, logs
- DaemonSets — rollout restart / status / history, logs
- CronJobs — suspend / resume (`kubectl patch`), **Run now**
  (`kubectl create job --from=cronjob/…`)
- Nodes — cordon / uncordon, drain (`--ignore-daemonsets
  --delete-emptydir-data`), resource usage
- anything else — describe, `-o yaml`, events, delete

Tick rows for a bulk delete. Nodes and Events are not deletable from here.

**Cluster…** — `kubectl top nodes`, `top pods --containers`, namespace events,
`cluster-info`, `api-resources`, and `explain` for the open type.

**Apply YAML…** — `kubectl apply -f -` with the document piped in through a
quoted heredoc: nothing is written to the host's disk. **Dry run** asks the API
server to validate first (`--dry-run=server`). `--prune` is never used — it
deletes objects merely absent from the pasted document.

**Failures a user can act on** — kubectl missing, no kubeconfig, a context that
does not exist, an unreachable API server, expired credentials, RBAC denial,
missing metrics-server, a rejected manifest — are explained with the fix, and the
raw stderr stays visible, because an RBAC message names the user, the verb and
the resource, and that is the whole diagnosis. `No resources found` is an empty
list, not an error, and is shown as the empty state.

**CLI prefix** (⚙) — `k3s kubectl`, `microk8s kubectl`, an absolute path, or
`env KUBECONFIG=/path/to/config kubectl` when the config is not at
`~/.kube/config`. This matters more than for most tools: these commands run on a
non-interactive exec channel, so a `KUBECONFIG` exported from `~/.bashrc` may
not be there.

**Language** — the panel follows the app's language (English / 简体中文) by
observing `<html lang>`, which the host sets.

## Command safety

Every command is a fixed verb plus values that are either validated against a
charset that cannot carry shell syntax, or single-quoted:

- resource names `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,252}$` (the `:` is for RBAC's
  `system:node`), namespaces RFC 1123, types `^[a-zA-Z][a-zA-Z0-9.-]{0,62}$`
- context names may contain `/`, `@` and `:` (an EKS ARN is a context name), so
  they are validated **and** quoted
- `--since`, `--tail`, `-c`, `--replicas`, `--to-revision`, port mappings and
  selectors each have their own pattern
- an exec command line is **tokenised** and re-quoted token by token, the way the
  CLI parses argv after `--`; `sh -c` mode quotes the whole line as one argument
- an applied manifest goes through a quoted heredoc, and a body containing the
  delimiter is refused rather than escaped
- `kubectl scale` is refused for a type that cannot be scaled, `rollout` for a
  verb outside its set, and a replica count outside 0…10000

A value that fails validation makes the client **reject**, because a name the
builders refuse means the parse it came from was wrong.

### Where the flags go

Every builder puts its flags **after** the subcommand and its positional
arguments — `kubectl get pods -A -o wide`, not `kubectl -A get pods`. kubectl only
knows `--context`, `--namespace` and the other kubeconfig flags at root level;
`-A` / `--all-namespaces` is local to the subcommands that list things, and an
unrecognised root-level flag is handed to kubectl's *plugin* resolver, which
fails with:

```text
error: flags cannot be placed before plugin name: -A
```

`-A` is also only passed to a listing (`get`, `get events`, `top pods`). A verb
that addresses one object gets that object's own namespace instead — "this pod,
in every namespace" is not a thing kubectl can do, and in `--all-namespaces` mode
the panel takes the namespace from the row it read (`client.withScope`).

Every destructive verb (delete, force delete, drain, rollout undo, scale to zero,
rollout restart, cronjob run) goes through a confirmation that shows the exact
command. A selector-wide `kubectl delete -l …` and a namespace-wide
`rollout restart` are deliberately absent: one command in the CLI, a cluster-wide
outage in one click.

## Layout

Nothing here is a single large file; each module is small and single-purpose.

```text
index.js            activation and host registration
kubectl.js          the barrel: one import point for everything below
kinds.js            the resource types offered, and the verbs each supports
cli/shell.js        prefix normalisation, quoting, tokenising, heredoc
cli/validate.js     the charsets every value must match
cli/get.js          get / describe / yaml / explain / top / events / kubeconfig
cli/workloads.js    scale / rollout / delete / cronjob / node maintenance
cli/session.js      logs / exec / apply / port-forward
parse/table.js      the `-o wide` table reader, by header offset
parse/status.js     what a cell's text means
failures.js         classification and wording
client.js           the async data layer, scoped to context + namespace
controller/         prefs, listings, pure derivations, overlays
panel/              header, toolbar, table, row actions, sheets, modals
ui/                 presentational primitives over the host React
i18n.js, locales/   en / zh-CN strings
icon.svg            the toolbar icon, served over `plugin://`
```

### Why parse the table instead of `-o json`

`kubectl get -o json` on a namespace of 200 pods is megabytes of manifest —
`managedFields` alone dwarfs everything the panel shows — and it would still need
per-type code to pick fields out. `-o wide` is the view a human gets, it is
small, and its columns are whatever the API server decided to print, which is
exactly what a CRD needs.

Parsing uses the **header's column offsets**, not whitespace splitting: kubectl
pads every column to its widest value, so a header name's position is the
column's start in every row. That keeps `5 (20s ago)` in `RESTARTS` as one value
and `NOMINATED NODE` as one column.

## Tests

```sh
npx vitest run src/plugins/__tests__/k8sPluginExample.test.js
```

The suite covers the command builders (including every refusal), the table
parser against real `-o wide` output, the status interpretation, the failure
classifier, the client's scope handling, and the panel's static render states.
