// Turning a share link into an Xray outbound.
//
// A subscription is a list of share links — `vless://`, `vmess://`,
// `trojan://`, `ss://` — and each one has to become an outbound object that
// Xray can actually dial. This module does that and nothing else: it takes a
// URI and returns `{ name, protocol, settings, streamSettings }`, or null when
// the link is not one it understands.
//
// The parsers are strict about what they accept. A link that does not carry
// an address and a port is refused rather than turned into an outbound that
// would fail at dial time, because a subscription can contain anything and a
// half-parsed node would show up in the panel as a working node.

/** Decodes base64 (and base64url) into a UTF-8 string. */
export function decodeBase64(text) {
  const normalized = String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!normalized) {
    return "";
  }
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

const decodeName = (value) => {
  const text = String(value ?? "").replace(/^#/, "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Percent-decoding that leaves a malformed escape alone. */
const safeDecodeURI = (value) => {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch {
    return String(value ?? "");
  }
};

const numberOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
};

const splitList = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * The stream settings, shared by every TLS-based protocol.
 *
 * `params` comes from the query string, so the names are the ones the share
 * links use: `type` for the transport, `security` for the encryption layer,
 * `sni`, `alpn`, `fp`, `path`, `host`, `serviceName`, `pbk`, `sid`.
 */
export function buildStreamSettings(params = {}, { network: forcedNetwork } = {}) {
  const network = forcedNetwork || params.type || "tcp";
  const security = params.security || "none";
  const stream = { network, security };

  if (security === "tls") {
    const tls = {};
    if (params.sni) {
      tls.serverName = params.sni;
    }
    if (params.host && !params.sni) {
      tls.serverName = params.host;
    }
    if (params.alpn) {
      tls.alpn = splitList(params.alpn);
    }
    if (params.fp) {
      tls.fingerprint = params.fp;
    }
    if (params.allowInsecure === "1" || params.allowInsecure === "true") {
      tls.allowInsecure = true;
    }
    stream.tlsSettings = tls;
  } else if (security === "reality") {
    const reality = {
      serverName: params.sni || params.host || "",
      fingerprint: params.fp || "chrome",
      publicKey: params.pbk || "",
      shortId: params.sid || "",
    };
    if (params.spx) {
      reality.spiderX = params.spx;
    }
    stream.realitySettings = reality;
  }

  if (network === "ws") {
    const ws = { path: params.path || "/" };
    if (params.host) {
      ws.headers = { Host: params.host };
    }
    stream.wsSettings = ws;
  } else if (network === "grpc") {
    const grpc = { serviceName: params.serviceName || params.path || "" };
    if (params.mode === "multi") {
      grpc.multiMode = true;
    }
    stream.grpcSettings = grpc;
  } else if (network === "http" || network === "h2") {
    const http = { path: params.path || "/" };
    if (params.host) {
      http.host = splitList(params.host);
    }
    stream.httpSettings = http;
  } else if (network === "tcp" && params.headerType === "http") {
    stream.tcpSettings = {
      header: {
        type: "http",
        request: {
          path: splitList(params.path || "/"),
          headers: { Host: splitList(params.host || "") },
        },
      },
    };
  }

  return stream;
}

/** The query string of a share link, as a plain object. */
export function queryParams(url) {
  const params = {};
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }
  return params;
}

/** `vless://uuid@host:port?...#name` */
export function parseVless(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const id = decodeName(url.username);
  const address = url.hostname;
  const port = numberOrNull(url.port) || 443;
  if (!id || !address) {
    return null;
  }
  const params = queryParams(url);
  const user = { id, encryption: params.encryption || "none" };
  if (params.flow) {
    user.flow = params.flow;
  }
  return {
    name: decodeName(url.hash) || `${address}:${port}`,
    protocol: "vless",
    settings: { vnext: [{ address, port, users: [user] }] },
    streamSettings: buildStreamSettings(params),
  };
}

/** `trojan://password@host:port?...#name` */
export function parseTrojan(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const password = decodeName(url.username);
  const address = url.hostname;
  const port = numberOrNull(url.port) || 443;
  if (!password || !address) {
    return null;
  }
  const params = queryParams(url);
  return {
    name: decodeName(url.hash) || `${address}:${port}`,
    protocol: "trojan",
    settings: { servers: [{ address, port, password }] },
    streamSettings: buildStreamSettings(params),
  };
}

/** `vmess://<base64 of a v2rayN JSON object>` */
export function parseVmess(uri) {
  const payload = String(uri ?? "").slice("vmess://".length);
  const decoded = decodeBase64(payload);
  if (!decoded) {
    return null;
  }
  let config;
  try {
    config = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!config || typeof config !== "object") {
    return null;
  }
  const address = String(config.add || "");
  const port = numberOrNull(config.port);
  const id = String(config.id || "");
  if (!address || !port || !id) {
    return null;
  }
  const params = {
    type: String(config.net || "tcp"),
    headerType: String(config.type || "none"),
    security: String(config.tls || "none"),
    sni: String(config.sni || ""),
    host: String(config.host || ""),
    path: String(config.path || ""),
    alpn: String(config.alpn || ""),
    fp: String(config.fp || ""),
  };
  const user = { id, alterId: Number(config.aid) || 0, security: String(config.scy || "auto") };
  return {
    name: String(config.ps || "") || `${address}:${port}`,
    protocol: "vmess",
    settings: { vnext: [{ address, port, users: [user] }] },
    streamSettings: buildStreamSettings(params),
  };
}

/**
 * `ss://`, in the three shapes it is written in:
 *
 *   ss://<base64(method:password)>@host:port#name     (SIP002)
 *   ss://method:password@host:port#name                (SIP002, plain)
 *   ss://<base64(method:password@host:port)>#name       (legacy)
 */
export function parseShadowsocks(uri) {
  const text = String(uri ?? "").trim();
  const hashIndex = text.indexOf("#");
  const name = hashIndex >= 0 ? decodeName(text.slice(hashIndex + 1)) : "";
  const body = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const schemeAt = body.indexOf("://");
  if (schemeAt < 0) {
    return null;
  }
  let rest = body.slice(schemeAt + 3);

  let userinfo;
  let hostport;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    userinfo = rest.slice(0, at);
    hostport = rest.slice(at + 1);
  } else {
    const decoded = decodeBase64(rest);
    const decodedAt = decoded.lastIndexOf("@");
    if (decodedAt < 0) {
      return null;
    }
    userinfo = decoded.slice(0, decodedAt);
    hostport = decoded.slice(decodedAt + 1);
  }

  let method;
  let password;
  const colon = userinfo.indexOf(":");
  if (colon >= 0) {
    method = decodeName(userinfo.slice(0, colon));
    password = decodeName(userinfo.slice(colon + 1));
  } else {
    // The base64 userinfo is percent-encoded by some providers (`%3D` for the
    // padding), so it is decoded before it is decoded again.
    const decoded = decodeBase64(safeDecodeURI(userinfo));
    const decodedColon = decoded.indexOf(":");
    if (decodedColon < 0) {
      return null;
    }
    method = decoded.slice(0, decodedColon);
    password = decoded.slice(decodedColon + 1);
  }
  if (!method || !password) {
    return null;
  }

  // A plugin query (`?plugin=...`) is not part of the endpoint.
  const endpoint = hostport.split("?")[0];
  const portSeparator = endpoint.lastIndexOf(":");
  if (portSeparator < 0) {
    return null;
  }
  const port = numberOrNull(endpoint.slice(portSeparator + 1));
  const address = endpoint.slice(0, portSeparator).replace(/^\[|\]$/g, "");
  if (!port || !address) {
    return null;
  }

  return {
    name: name || `${address}:${port}`,
    protocol: "shadowsocks",
    settings: { servers: [{ address, port, method, password }] },
    streamSettings: { network: "tcp", security: "none" },
  };
}

/** Parses one share link, whatever protocol it carries. */
export function parseNodeUri(uri) {
  const text = String(uri ?? "").trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("vless://")) {
    return parseVless(text);
  }
  if (lower.startsWith("trojan://")) {
    return parseTrojan(text);
  }
  if (lower.startsWith("vmess://")) {
    return parseVmess(text);
  }
  if (lower.startsWith("ss://")) {
    return parseShadowsocks(text);
  }
  return null;
}

/** The protocols the panel can turn into outbounds. */
export const SUPPORTED_SCHEMES = ["vless://", "vmess://", "trojan://", "ss://"];
