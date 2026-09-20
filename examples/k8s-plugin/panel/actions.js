// The per-row action menu.
//
// What a row offers comes from its resource type's descriptor (`kinds.js`), so a
// CRD reached through the "other type" box still gets the four verbs that apply
// to everything — describe, yaml, events, delete — and nothing that would fail.
//
// Every destructive verb goes through `askConfirm`, which shows the exact
// command; `kubectl delete` has no undo.

import { ACTIONS, supports } from "../kinds.js";
import { copyText, manualJobName } from "./format.js";

export function createRowActions({ h, ui, t }) {
  const { Button, Menu } = ui;

  /** `kind/name`, plus the namespace when the listing spans all of them. */
  const label = (c, row) =>
    row.namespace && c.allNamespaces ? `${row.namespace}/${row.name}` : row.name;

  const commandFor = (c, row, verb) =>
    `kubectl ${verb} ${c.descriptor.kind}/${row.name}${row.namespace ? ` -n ${row.namespace}` : ""}`;

  const run = (c, row, verb, call) =>
    c.task(row.key, `kubectl ${verb} ${label(c, row)}`, () => call(c.clientFor(row)));

  const commonItems = (c, row) => [
    {
      key: "describe",
      label: t("Describe"),
      hint: "kubectl describe",
      onClick: () =>
        c.openText(
          `${t("Describe")} · ${label(c, row)}`,
          commandFor(c, row, "describe"),
          () => c.clientFor(row).describe(c.descriptor.kind, row.name),
        ),
    },
    {
      key: "yaml",
      label: t("YAML"),
      hint: "-o yaml",
      onClick: () =>
        c.openText(
          `${t("YAML")} · ${label(c, row)}`,
          commandFor(c, row, "get") + " -o yaml",
          () => c.clientFor(row).yaml(c.descriptor.kind, row.name),
        ),
    },
    {
      key: "events",
      label: t("Events"),
      hint: "kubectl get events",
      onClick: () =>
        c.openTable(`${t("Events")} · ${label(c, row)}`, "kubectl get events", () =>
          c.clientFor(row).events({ objectName: row.name }),
        ),
    },
    { key: "copy", label: t("Copy name"), onClick: () => copyText(row.name) },
  ];

  const podItems = (c, row) => [
    {
      key: "logs",
      label: t("Logs"),
      hint: "kubectl logs",
      onClick: () => c.openLogs({ pod: row.name, namespace: row.namespace, title: label(c, row) }),
    },
    {
      key: "exec",
      label: t("Exec"),
      hint: "kubectl exec",
      onClick: () => c.openExec(row.name, row.namespace),
    },
    {
      key: "portforward",
      label: t("Port forward…"),
      hint: "kubectl port-forward",
      onClick: () => c.openModal({ kind: "portForward", row }),
    },
  ];

  const scaleItem = (c, row) => ({
    key: "scale",
    label: t("Scale…"),
    hint: "kubectl scale",
    onClick: () => c.openModal({ kind: "scale", row }),
  });

  const rolloutItems = (c, row) => [
    {
      key: "restart",
      label: t("Rollout restart"),
      hint: "rollout restart",
      onClick: () =>
        c.askConfirm({
          title: t("Restart this workload?"),
          body: t("Every pod is replaced, one batch at a time, by the controller."),
          command: `kubectl rollout restart ${c.descriptor.kind}/${row.name}`,
          confirmLabel: t("Restart"),
          run: () => run(c, row, "rollout restart", (client) => client.rollout("restart", c.descriptor.kind, row.name)),
        }),
    },
    {
      key: "status",
      label: t("Rollout status"),
      hint: "rollout status",
      onClick: () =>
        c.openText(`${t("Rollout status")} · ${label(c, row)}`, "kubectl rollout status", () =>
          c.clientFor(row).rollout("status", c.descriptor.kind, row.name),
        ),
    },
    {
      key: "history",
      label: t("Rollout history"),
      hint: "rollout history",
      onClick: () =>
        c.openText(`${t("Rollout history")} · ${label(c, row)}`, "kubectl rollout history", () =>
          c.clientFor(row).rollout("history", c.descriptor.kind, row.name),
        ),
    },
    {
      key: "undo",
      label: t("Roll back"),
      hint: "rollout undo",
      tone: "danger",
      onClick: () =>
        c.askConfirm({
          title: t("Roll back to the previous revision?"),
          command: `kubectl rollout undo ${c.descriptor.kind}/${row.name}`,
          confirmLabel: t("Roll back"),
          tone: "danger",
          run: () => run(c, row, "rollout undo", (client) => client.rollout("undo", c.descriptor.kind, row.name)),
        }),
    },
  ];

  const cronJobItems = (c, row) => {
    const suspended = String(row.byName.SUSPEND || "").toLowerCase() === "true";
    return [
      {
        key: "suspend",
        label: suspended ? t("Resume") : t("Suspend"),
        hint: "kubectl patch",
        onClick: () =>
          run(c, row, suspended ? "resume" : "suspend", (client) =>
            client.setSuspend(row.name, !suspended),
          ),
      },
      {
        key: "trigger",
        label: t("Run now"),
        hint: "create job --from",
        onClick: () =>
          c.askConfirm({
            title: t("Run this CronJob now?"),
            body: t("A Job is created from the CronJob's template, outside its schedule."),
            command: `kubectl create job ${manualJobName(row.name)} --from=cronjob/${row.name}`,
            confirmLabel: t("Run now"),
            run: () =>
              run(c, row, "create job", (client) =>
                client.triggerCronJob(row.name, manualJobName(row.name)),
              ),
          }),
      },
    ];
  };

  const nodeItems = (c, row) => {
    const unschedulable = /SchedulingDisabled/i.test(row.byName.STATUS || "");
    return [
      {
        key: "cordon",
        label: unschedulable ? t("Uncordon") : t("Cordon"),
        hint: unschedulable ? "kubectl uncordon" : "kubectl cordon",
        onClick: () =>
          run(c, row, unschedulable ? "uncordon" : "cordon", (client) =>
            unschedulable ? client.uncordon(row.name) : client.cordon(row.name),
          ),
      },
      {
        key: "drain",
        label: t("Drain…"),
        hint: "kubectl drain",
        tone: "danger",
        onClick: () =>
          c.askConfirm({
            title: t("Drain this node?"),
            body: t(
              "Every pod is evicted and the node is cordoned. DaemonSet pods are left alone and emptyDir data is deleted.",
            ),
            command: `kubectl drain ${row.name} --ignore-daemonsets --delete-emptydir-data`,
            confirmLabel: t("Drain"),
            tone: "danger",
            run: () => run(c, row, "drain", (client) => client.drain(row.name)),
          }),
      },
      {
        key: "top",
        label: t("Resource usage"),
        hint: "kubectl top node",
        onClick: () =>
          c.openTable(
            `${t("Resource usage")} · ${row.name}`,
            `kubectl top node ${row.name}`,
            () => c.client.top("nodes", { name: row.name }),
          ),
      },
    ];
  };

  const deleteItems = (c, row) => {
    if (c.descriptor.noDelete) {
      return [];
    }
    const items = [
      {
        key: "delete",
        label: t("Delete"),
        hint: "kubectl delete",
        tone: "danger",
        onClick: () =>
          c.askConfirm({
            title: t("Delete {name}?", { name: label(c, row) }),
            body: t("There is no undo. A controller may recreate it immediately."),
            command: commandFor(c, row, "delete"),
            confirmLabel: t("Delete"),
            tone: "danger",
            run: () => run(c, row, "delete", (client) => client.remove(c.descriptor.kind, row.name)),
          }),
      },
    ];
    if (c.descriptor.key === "pods") {
      items.push({
        key: "forceDelete",
        label: t("Force delete"),
        hint: "--force --grace-period=0",
        tone: "danger",
        onClick: () =>
          c.askConfirm({
            title: t("Force-delete {name}?", { name: label(c, row) }),
            body: t(
              "The API object is removed without waiting for the kubelet. For a StatefulSet pod this can break the at-most-one guarantee.",
            ),
            command: `${commandFor(c, row, "delete")} --force --grace-period=0`,
            confirmLabel: t("Force delete"),
            tone: "danger",
            run: () =>
              run(c, row, "delete --force", (client) =>
                client.remove(c.descriptor.kind, row.name, { force: true }),
              ),
          }),
      });
    }
    return items;
  };

  /** The full menu for one row, in the order a user reaches for it. */
  const menuItems = (c, row) => {
    const items = [];
    if (supports(c.descriptor, ACTIONS.logs) && c.descriptor.key !== "pods") {
      items.push({
        key: "logs",
        label: t("Logs"),
        hint: "kubectl logs",
        onClick: () =>
          c.openLogs({
            kind: c.descriptor.kind,
            name: row.name,
            namespace: row.namespace,
            title: label(c, row),
          }),
      });
    }
    if (supports(c.descriptor, ACTIONS.logs) && c.descriptor.key === "pods") {
      items.push(...podItems(c, row));
    }
    if (supports(c.descriptor, ACTIONS.scale)) {
      items.push(scaleItem(c, row));
    }
    if (supports(c.descriptor, ACTIONS.rollout)) {
      items.push(...rolloutItems(c, row));
    }
    if (supports(c.descriptor, ACTIONS.suspend)) {
      items.push(...cronJobItems(c, row));
    }
    if (supports(c.descriptor, ACTIONS.node)) {
      items.push(...nodeItems(c, row));
    }
    if (items.length > 0) {
      items.push({ separator: true });
    }
    items.push(...commonItems(c, row));
    const removals = deleteItems(c, row);
    if (removals.length > 0) {
      items.push({ separator: true }, ...removals);
    }
    return items;
  };

  /** The inline buttons: the one action a row is usually opened for, plus the menu. */
  const rowActions = (c, row) =>
    h(
      "div",
      { className: "flex items-center justify-end gap-1" },
      supports(c.descriptor, ACTIONS.logs)
        ? h(Button, {
            label: t("Logs"),
            size: "xs",
            title: `kubectl logs ${row.name}`,
            onClick: () =>
              c.openLogs(
                c.descriptor.key === "pods"
                  ? { pod: row.name, namespace: row.namespace, title: label(c, row) }
                  : {
                      kind: c.descriptor.kind,
                      name: row.name,
                      namespace: row.namespace,
                      title: label(c, row),
                    },
              ),
          })
        : h(Button, {
            label: t("Describe"),
            size: "xs",
            title: `kubectl describe ${c.descriptor.kind}/${row.name}`,
            onClick: () =>
              c.openText(
                `${t("Describe")} · ${label(c, row)}`,
                commandFor(c, row, "describe"),
                () => c.clientFor(row).describe(c.descriptor.kind, row.name),
              ),
          }),
      h(Menu, { items: menuItems(c, row) }),
    );

  return { menuItems, rowActions, rowLabel: label };
}
