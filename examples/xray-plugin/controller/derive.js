// Pure derivations over the config, the subscriptions and the stored group
// state. Nothing here touches React or the facade, so every rule the panel
// shows can be tested directly.

import {
  listGroups,
  listNodes,
  nodesOfGroup,
  pinnedNodeOf,
  rulesOfGroup,
} from "../parse/config.js";

/** The nodes a group can pick from, using the selector it was configured with. */
const effectiveSelector = (group, state) => {
  const remembered = state && Array.isArray(state.autoSelector) ? state.autoSelector : [];
  return remembered.length > 0 ? remembered : group.selector;
};

/**
 * The groups, with everything the panel shows about them.
 *
 * A pinned group keeps the wider selector in the panel's own state, so the
 * list of members does not collapse to one entry while a node is selected.
 */
export function enrichGroups(config, groupState = {}) {
  const groups = listGroups(config);
  const nodes = listNodes(config).filter((node) => node.isNode);
  return groups.map((group) => {
    const state = groupState[group.tag] || {};
    const selector = effectiveSelector(group, state);
    const members = nodes.filter((node) =>
      selector.some((prefix) => node.tag.startsWith(prefix)),
    );
    const pinned = pinnedNodeOf(config, group);
    return {
      ...group,
      memberCount: members.length,
      memberTags: members.map((node) => node.tag),
      autoSelector: selector,
      pinnedTag: pinned ? pinned.tag : "",
      isPinned: Boolean(pinned),
      unused: group.ruleCount === 0,
      rules: rulesOfGroup(config, group.tag),
    };
  });
}

/** The display names the subscriptions recorded, keyed by node tag. */
export function nodeNames(subscriptions) {
  const names = {};
  for (const subscription of subscriptions || []) {
    for (const node of subscription.nodes || []) {
      if (node && node.tag && node.name) {
        names[node.tag] = node.name;
      }
    }
  }
  return names;
}

/** The nodes of one group, with the names the subscriptions recorded. */
export function groupNodes(config, group, names = {}) {
  if (!group) {
    return [];
  }
  return nodesOfGroup(config, group).map((node) => ({
    ...node,
    name: names[node.tag] || node.tag,
  }));
}

/** Filters nodes by a free-text query over the tag, the name and the address. */
export function matchNodes(nodes, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return nodes;
  }
  return nodes.filter((node) =>
    [node.tag, node.name, node.address, node.protocol]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle)),
  );
}

/**
 * The subscriptions, with what the config says about them.
 *
 * A subscription owns the outbounds whose tag carries its prefix, so the
 * node count here is the count in the config — not what the provider last
 * served. The two are compared by the panel, which is how a subscription that
 * was never applied shows up.
 */
export function enrichSubscriptions(subscriptions, config) {
  const nodes = listNodes(config).filter((node) => node.isNode);
  return (subscriptions || []).map((subscription) => {
    const owned = nodes.filter((node) => node.tag.startsWith(`${subscription.prefix}-`));
    return {
      ...subscription,
      configuredCount: owned.length,
      outdated: owned.length !== (subscription.nodeCount || 0),
    };
  });
}

/** A short, safe label for a subscription URL: the host and the last path. */
export function maskUrl(url) {
  const text = String(url ?? "");
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.length > 0 ? segments[segments.length - 1] : "";
    const shown = last.length > 6 ? `${last.slice(0, 3)}…${last.slice(-2)}` : last;
    return `${parsed.host}${shown ? `/${shown}` : ""}`;
  } catch {
    return "…";
  }
}

/** The strategy names, with the label the panel shows. */
export const STRATEGY_LABELS = {
  random: "Random",
  roundRobin: "Round robin",
  leastPing: "Least ping",
  leastLoad: "Least load",
};

/**
 * The delay table, merged with the log's own measurements.
 *
 * The observatory writes one line per probe, so the last line for a tag is
 * the freshest reading. A tag with no reading keeps no entry.
 */
export function mergeDelays(measurements, delays) {
  const merged = { ...delays };
  for (const [tag, value] of Object.entries(measurements || {})) {
    if (value && Number.isFinite(value.delay)) {
      merged[tag] = value.delay;
    }
  }
  return merged;
}
