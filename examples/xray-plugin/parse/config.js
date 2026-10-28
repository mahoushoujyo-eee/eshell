// The Xray configuration, as a model.
//
// The panel reads the config as JSON and works on that model; it never edits
// the file as text. Everything in this module is a pure function over the
// parsed object, so the transformation the panel applies can be tested
// without a host.
//
// The three things the panel manages map onto Xray's own concepts:
//
//   group  ->  routing.balancers[]   a tag, the tag prefixes it selects from,
//                                     and the strategy it picks with
//   node   ->  outbounds[]           one proxy server, tagged so a balancer's
//                                     selector can find it
//   rule   ->  routing.rules[]       what sends traffic to a balancer; read
//                                     here, never written

/** The tag a subscription stamps on the nodes it owns. */
export const nodeTag = (prefix, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`;

/** Whether an outbound tag belongs to the given prefix. */
export const ownsTag = (tag, prefix) =>
  typeof tag === "string" && (tag === prefix || tag.startsWith(`${prefix}-`));

/** Parses the config file's contents. */
export function parseConfig(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { ok: false, error: "the config file is empty" };
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { ok: false, error: "the config file is not a JSON object" };
    }
    return { ok: true, config };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** The outbounds that are proxy nodes rather than freedom/blackhole/dns. */
export const isNodeOutbound = (outbound) => {
  const settings = (outbound && outbound.settings) || {};
  return (
    Array.isArray(settings.vnext) && settings.vnext.length > 0
  ) || (Array.isArray(settings.servers) && settings.servers.length > 0);
};

const addressOf = (outbound) => {
  const settings = (outbound && outbound.settings) || {};
  const vnext = Array.isArray(settings.vnext) ? settings.vnext[0] : null;
  const server = Array.isArray(settings.servers) ? settings.servers[0] : null;
  return (vnext && vnext.address) || (server && server.address) || "";
};

const portOf = (outbound) => {
  const settings = (outbound && outbound.settings) || {};
  const vnext = Array.isArray(settings.vnext) ? settings.vnext[0] : null;
  const server = Array.isArray(settings.servers) ? settings.servers[0] : null;
  const port = (vnext && vnext.port) || (server && server.port);
  const numeric = Number(port);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

/** Every outbound, described for the panel. */
export function listNodes(config) {
  const outbounds = Array.isArray(config && config.outbounds) ? config.outbounds : [];
  return outbounds
    .filter((outbound) => outbound && typeof outbound === "object")
    .map((outbound, index) => {
      const stream = outbound.streamSettings || {};
      return {
        index,
        tag: String(outbound.tag || `outbound-${index + 1}`),
        protocol: String(outbound.protocol || ""),
        address: addressOf(outbound),
        port: portOf(outbound),
        network: String(stream.network || "tcp"),
        security: String(stream.security || "none"),
        isNode: isNodeOutbound(outbound),
      };
    });
}

/** Every balancer, described for the panel. */
export function listGroups(config) {
  const routing = (config && config.routing) || {};
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const rules = Array.isArray(routing.rules) ? routing.rules : [];
  return balancers
    .filter((balancer) => balancer && typeof balancer === "object" && balancer.tag)
    .map((balancer) => ({
      tag: String(balancer.tag),
      selector: Array.isArray(balancer.selector) ? balancer.selector.map(String) : [],
      strategy: String((balancer.strategy && balancer.strategy.type) || "random"),
      fallbackTag: balancer.fallbackTag ? String(balancer.fallbackTag) : "",
      ruleCount: rules.filter((rule) => rule && rule.balancerTag === balancer.tag).length,
    }));
}

/** The balancer with this tag, or null. */
export const findGroup = (config, tag) =>
  listGroups(config).find((group) => group.tag === tag) || null;

/**
 * The node a balancer is pinned to, if it is pinned.
 *
 * A balancer is "pinned" when its selector names exactly one outbound that
 * exists — that is what selecting a node writes. The panel remembers the
 * wider selector separately so it can be restored.
 */
export function pinnedNodeOf(config, group) {
  if (!group || group.selector.length !== 1) {
    return null;
  }
  const nodes = listNodes(config);
  return nodes.find((node) => node.tag === group.selector[0]) || null;
}

/** The nodes a balancer selects, by its tag prefixes. */
export function nodesOfGroup(config, group) {
  if (!group) {
    return [];
  }
  const nodes = listNodes(config).filter((node) => node.isNode);
  if (group.selector.length === 0) {
    return [];
  }
  return nodes.filter((node) => group.selector.some((prefix) => node.tag.startsWith(prefix)));
}

/** Adds or updates a balancer. */
export function upsertGroup(config, group) {
  const routing = config.routing && typeof config.routing === "object" ? config.routing : {};
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const index = balancers.findIndex((balancer) => balancer && balancer.tag === group.tag);
  const previous = index >= 0 ? balancers[index] : null;
  const previousStrategy = previous && previous.strategy;
  // A strategy carries its own settings (`expectedIPs` for leastPing). They
  // survive a strategy change only when the strategy itself did not change —
  // `expectedIPs` means nothing to `random`.
  const strategy =
    previousStrategy && previousStrategy.type === group.strategy
      ? { ...previousStrategy, type: group.strategy }
      : { type: group.strategy };

  const entry = { tag: group.tag, selector: [...group.selector], strategy };
  if (group.fallbackTag) {
    entry.fallbackTag = group.fallbackTag;
  }

  if (index >= 0) {
    balancers[index] = entry;
  } else {
    balancers.push(entry);
  }
  routing.balancers = balancers;
  config.routing = routing;
  return config;
}

/** Removes a balancer. Returns whether one was there. */
export function removeGroup(config, tag) {
  const routing = (config && config.routing) || {};
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const next = balancers.filter((balancer) => !balancer || balancer.tag !== tag);
  const removed = next.length !== balancers.length;
  routing.balancers = next;
  config.routing = routing;
  return removed;
}

/** Rewrites a balancer's selector. */
export function setGroupSelector(config, tag, selector) {
  const routing = (config && config.routing) || {};
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const index = balancers.findIndex((balancer) => balancer && balancer.tag === tag);
  if (index < 0) {
    return false;
  }
  balancers[index] = { ...balancers[index], selector: [...selector] };
  routing.balancers = balancers;
  config.routing = routing;
  return true;
}

/**
 * Replaces the nodes a subscription owns.
 *
 * Ownership is by tag prefix: everything tagged `hk` or `hk-*` belongs to the
 * subscription with the prefix `hk`, and is replaced as a set. That is what
 * makes an update idempotent — a subscription that no longer lists a node
 * loses it.
 */
export function replaceNodes(config, prefix, nodes) {
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  const keep = outbounds.filter((outbound) => !ownsTag(outbound && outbound.tag, prefix));
  const removed = outbounds.length - keep.length;
  const added = (nodes || []).map((node, index) => ({
    ...node,
    tag: nodeTag(prefix, index),
  }));
  config.outbounds = [...keep, ...added];
  return { removed, added: added.length, nodes: added };
}

/** The endpoint of an outbound: where it dials. */
export const nodeEndpoint = (outbound) => ({
  address: addressOf(outbound),
  port: portOf(outbound),
});

/** The port of the first SOCKS inbound, and of the first HTTP inbound. */
export function inboundPorts(config) {
  const inbounds = Array.isArray(config && config.inbounds) ? config.inbounds : [];
  const find = (protocol) => {
    const match = inbounds.find(
      (inbound) => inbound && inbound.protocol === protocol && Number(inbound.port) > 0,
    );
    return match ? Number(match.port) : null;
  };
  return { socks: find("socks"), http: find("http") };
}

/** The counts and capabilities the panel's overview shows. */
export function summarize(config) {
  const routing = (config && config.routing) || {};
  const nodes = listNodes(config).filter((node) => node.isNode);
  const log = (config && config.log) || {};
  return {
    inboundCount: Array.isArray(config && config.inbounds) ? config.inbounds.length : 0,
    outboundCount: Array.isArray(config && config.outbounds) ? config.outbounds.length : 0,
    nodeCount: nodes.length,
    groupCount: Array.isArray(routing.balancers) ? routing.balancers.length : 0,
    ruleCount: Array.isArray(routing.rules) ? routing.rules.length : 0,
    apiEnabled: Boolean(config && config.api && Array.isArray(config.api.services) && config.api.services.length),
    observatory: Boolean((config && config.observatory) || (config && config.burstObservatory)),
    logPath: String(log.access || log.error || ""),
    domainStrategy: String(routing.domainStrategy || ""),
  };
}

/** The routing rules that point at a balancer. */
export function rulesOfGroup(config, tag) {
  const routing = (config && config.routing) || {};
  const rules = Array.isArray(routing.rules) ? routing.rules : [];
  return rules
    .filter((rule) => rule && rule.balancerTag === tag)
    .map((rule, index) => ({
      index,
      type: String(rule.type || "field"),
      domain: Array.isArray(rule.domain) ? rule.domain : [],
      ip: Array.isArray(rule.ip) ? rule.ip : [],
      port: String(rule.port || ""),
      network: String(rule.network || ""),
      inboundTag: Array.isArray(rule.inboundTag) ? rule.inboundTag : [],
    }));
}
