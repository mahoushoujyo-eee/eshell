// Reading a subscription.
//
// A subscription is whatever the provider serves. The panel reads the shapes
// that carry the information Xray needs, and says plainly which shape it does
// not read rather than silently importing half of it:
//
//   v2ray link list      the base64 blob every provider serves — one share
//                        link per line
//   plain link list      the same, without the base64 wrapper
//   Xray JSON            `{"outbounds": [...]}` — the outbounds are taken as
//                        they are
//   v2ray "configs"      the older `{"configs": [...]}` shape
//
// A Clash YAML subscription is detected and refused with an explanation. The
// panel would have to read YAML to convert it, and a partial YAML reader
// turns a provider's list into a subtly wrong one.

import { decodeBase64, parseNodeUri } from "./uri.js";

/** The formats the panel knows about. */
export const SUBSCRIPTION_FORMATS = {
  URI_LIST: "uri-list",
  BASE64: "base64",
  XRAY_JSON: "xray-json",
  V2RAY_CONFIGS: "v2ray-configs",
  CLASH: "clash",
  UNKNOWN: "unknown",
};

const CLASH_MESSAGE =
  "This subscription is a Clash YAML document. The panel reads vless/vmess/trojan/ss link lists and Xray JSON configs — ask the provider for the v2ray (link) subscription, or convert the YAML on the host first.";

const looksLikeBase64 = (text) => /^[A-Za-z0-9+/\s=]+$/.test(text);

/** Parses a list of share links. */
function parseUriList(text, format) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const nodes = [];
  let skipped = 0;
  for (const line of lines) {
    const node = parseNodeUri(line);
    if (node) {
      nodes.push(node);
    } else {
      skipped += 1;
    }
  }
  if (nodes.length === 0) {
    return {
      ok: false,
      format,
      nodes: [],
      skipped,
      message: "no node in the subscription could be read",
    };
  }
  return { ok: true, format, nodes, skipped, message: "" };
}

/** The outbounds of an Xray JSON subscription, without their tags. */
function parseXrayJson(config) {
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  const nodes = [];
  let skipped = 0;
  for (const outbound of outbounds) {
    if (!outbound || typeof outbound !== "object" || !outbound.protocol) {
      skipped += 1;
      continue;
    }
    nodes.push({
      name: String(outbound.tag || ""),
      protocol: String(outbound.protocol),
      settings: outbound.settings || {},
      streamSettings: outbound.streamSettings || {},
      sendThrough: outbound.sendThrough,
    });
  }
  if (nodes.length === 0) {
    return {
      ok: false,
      format: SUBSCRIPTION_FORMATS.XRAY_JSON,
      nodes: [],
      skipped,
      message: "the JSON config carries no outbounds",
    };
  }
  return {
    ok: true,
    format: SUBSCRIPTION_FORMATS.XRAY_JSON,
    nodes,
    skipped,
    message: "",
  };
}

/** The older `{"configs": [...]}` subscription shape. */
function parseV2rayConfigs(config) {
  const configs = Array.isArray(config.configs) ? config.configs : [];
  const nodes = [];
  let skipped = 0;
  for (const entry of configs) {
    if (!entry || typeof entry !== "object" || !entry.protocol || !entry.address) {
      skipped += 1;
      continue;
    }
    nodes.push({
      name: String(entry.outboundTag || entry.remarks || ""),
      protocol: String(entry.protocol),
      settings: entry.settings || {},
      streamSettings: entry.streamSettings || {},
    });
  }
  if (nodes.length === 0) {
    return {
      ok: false,
      format: SUBSCRIPTION_FORMATS.V2RAY_CONFIGS,
      nodes: [],
      skipped,
      message: "the subscription carries no usable configs",
    };
  }
  return {
    ok: true,
    format: SUBSCRIPTION_FORMATS.V2RAY_CONFIGS,
    nodes,
    skipped,
    message: "",
  };
}

/**
 * Reads a subscription body.
 *
 * The result carries the format it was read from, so the panel can say what
 * it got, the nodes it understood, and how many entries it skipped.
 */
export function parseSubscription(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      format: SUBSCRIPTION_FORMATS.UNKNOWN,
      nodes: [],
      skipped: 0,
      message: "the subscription body is empty",
    };
  }

  if (raw.startsWith("{")) {
    let config;
    try {
      config = JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        format: SUBSCRIPTION_FORMATS.UNKNOWN,
        nodes: [],
        skipped: 0,
        message: `the subscription is not valid JSON: ${String((error && error.message) || error)}`,
      };
    }
    if (config && Array.isArray(config.outbounds)) {
      return parseXrayJson(config);
    }
    if (config && Array.isArray(config.configs)) {
      return parseV2rayConfigs(config);
    }
    return {
      ok: false,
      format: SUBSCRIPTION_FORMATS.UNKNOWN,
      nodes: [],
      skipped: 0,
      message: "the JSON subscription has neither outbounds nor configs",
    };
  }

  if (raw.includes("://")) {
    return parseUriList(raw, SUBSCRIPTION_FORMATS.URI_LIST);
  }

  if (looksLikeBase64(raw)) {
    const decoded = decodeBase64(raw);
    if (decoded) {
      if (decoded.includes("://")) {
        return parseUriList(decoded, SUBSCRIPTION_FORMATS.BASE64);
      }
      if (/^\s*(proxies|proxy-providers)\s*:/m.test(decoded)) {
        return {
          ok: false,
          format: SUBSCRIPTION_FORMATS.CLASH,
          nodes: [],
          skipped: 0,
          message: CLASH_MESSAGE,
        };
      }
    }
  }

  if (/^\s*(proxies|proxy-providers)\s*:/m.test(raw)) {
    return {
      ok: false,
      format: SUBSCRIPTION_FORMATS.CLASH,
      nodes: [],
      skipped: 0,
      message: CLASH_MESSAGE,
    };
  }

  return {
    ok: false,
    format: SUBSCRIPTION_FORMATS.UNKNOWN,
    nodes: [],
    skipped: 0,
    message: "the subscription is not a link list, a base64 blob or a JSON config",
  };
}
