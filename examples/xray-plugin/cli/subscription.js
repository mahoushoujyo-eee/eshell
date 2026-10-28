// Fetching a subscription and probing the live path.
//
// The panel has no HTTP client of its own — the plugin facade exposes no
// network call and no local process — so the download happens on the host
// that will use the nodes. That is also the only sensible place for it: the
// subscription has to be fetched from the same network the proxies live on.
//
// The body is not written to disk: it comes back on stdout and is parsed in
// the panel.

import { shellQuote } from "./shell.js";

/**
 * The download command.
 *
 * `-f` makes curl fail on an HTTP error instead of returning the error page
 * as if it were a subscription, and `-L` follows the redirect every provider
 * uses. The user agent is set because some hosts answer a bare curl with 403.
 */
export const fetchCommand = ({ url, tool = "curl", timeout = 30 }) => {
  if (tool === "wget") {
    return `wget -q -O - --timeout=${timeout} ${shellQuote(url)}`;
  }
  return `curl -fsSL --max-time ${timeout} -A "Mozilla/5.0" ${shellQuote(url)}`;
};

/**
 * Measures the latency of the path the server is actually using right now:
 * a request through the local SOCKS inbound, so it exercises the selected
 * node and the outbound behind it.
 *
 * `socks5h` resolves the target name through the proxy, which is what a
 * client behind the proxy would do, and it keeps the test from depending on
 * the host's own DNS.
 */
export const probeCommand = ({ socksPort, url, timeout = 10 }) =>
  `curl -s -o /dev/null -w "%{time_total}" --max-time ${timeout} --proxy socks5h://127.0.0.1:${Number(
    socksPort,
  )} ${shellQuote(url)}`;

/**
 * The plain reachability probe, used when the config has no SOCKS inbound to
 * route through: it asks the host itself, not the proxy.
 */
export const directProbeCommand = ({ url, timeout = 10 }) =>
  `curl -s -o /dev/null -w "%{time_total}" --max-time ${timeout} ${shellQuote(url)}`;
