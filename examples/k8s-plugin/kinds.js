// The resource types the panel offers as tabs, and what can be done to each.
//
// `kubectl get <anything>` still works through the "other type" box — this list
// is the shortcut, not the limit. Actions are declared here so the row menu and
// the bulk bar agree on what a type supports, and so a CRD (which reaches the
// panel through the free-text box) falls back to the four verbs that apply to
// everything: describe, yaml, events, delete.

/** Verbs the panel knows how to run. */
export const ACTIONS = {
  logs: "logs",
  exec: "exec",
  scale: "scale",
  rollout: "rollout",
  suspend: "suspend",
  trigger: "trigger",
  node: "node",
  portForward: "portForward",
};

const COMMON = [];

export const KINDS = [
  {
    key: "pods",
    kind: "pods",
    label: "Pods",
    namespaced: true,
    actions: [ACTIONS.logs, ACTIONS.exec, ACTIONS.portForward],
  },
  {
    key: "deployments",
    kind: "deployments",
    label: "Deployments",
    namespaced: true,
    actions: [ACTIONS.scale, ACTIONS.rollout, ACTIONS.logs],
  },
  {
    key: "statefulsets",
    kind: "statefulsets",
    label: "StatefulSets",
    namespaced: true,
    actions: [ACTIONS.scale, ACTIONS.rollout, ACTIONS.logs],
  },
  {
    key: "daemonsets",
    kind: "daemonsets",
    label: "DaemonSets",
    namespaced: true,
    actions: [ACTIONS.rollout, ACTIONS.logs],
  },
  {
    key: "replicasets",
    kind: "replicasets",
    label: "ReplicaSets",
    namespaced: true,
    actions: [ACTIONS.scale, ACTIONS.logs],
  },
  { key: "services", kind: "services", label: "Services", namespaced: true, actions: COMMON },
  { key: "ingresses", kind: "ingresses", label: "Ingresses", namespaced: true, actions: COMMON },
  {
    key: "jobs",
    kind: "jobs",
    label: "Jobs",
    namespaced: true,
    actions: [ACTIONS.logs],
  },
  {
    key: "cronjobs",
    kind: "cronjobs",
    label: "CronJobs",
    namespaced: true,
    actions: [ACTIONS.suspend, ACTIONS.trigger],
  },
  { key: "configmaps", kind: "configmaps", label: "ConfigMaps", namespaced: true, actions: COMMON },
  { key: "secrets", kind: "secrets", label: "Secrets", namespaced: true, actions: COMMON },
  {
    key: "pvc",
    kind: "persistentvolumeclaims",
    label: "PVCs",
    namespaced: true,
    actions: COMMON,
  },
  { key: "pv", kind: "persistentvolumes", label: "PVs", namespaced: false, actions: COMMON },
  {
    key: "nodes",
    kind: "nodes",
    label: "Nodes",
    namespaced: false,
    actions: [ACTIONS.node],
    // A node is infrastructure: `kubectl delete node` only removes it from the
    // API, which is almost never what a click meant.
    noDelete: true,
  },
  {
    key: "namespaces",
    kind: "namespaces",
    label: "Namespaces",
    namespaced: false,
    actions: COMMON,
  },
  { key: "events", kind: "events", label: "Events", namespaced: true, actions: COMMON, noDelete: true },
];

export const KIND_BY_KEY = new Map(KINDS.map((entry) => [entry.key, entry]));

/** The descriptor for a tab key, or a generic one for a typed-in resource type. */
export function resolveKind(key) {
  const known = KIND_BY_KEY.get(key);
  if (known) {
    return known;
  }
  return {
    key,
    kind: key,
    label: key,
    // An unknown type is assumed namespaced, which is true of most CRDs; the
    // namespace flag is harmless on a cluster-scoped type (kubectl ignores it).
    namespaced: true,
    actions: COMMON,
    custom: true,
  };
}

export const supports = (descriptor, action) =>
  Boolean(descriptor && descriptor.actions && descriptor.actions.includes(action));
