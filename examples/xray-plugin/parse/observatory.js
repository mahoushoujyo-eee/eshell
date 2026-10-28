// Reading the delay measurements out of the xray log.
//
// Xray's observatory probes the outbounds that match its subject selector and
// writes one JSON object per probe into the log:
//
//   {"outboundTag":"hk-01","delay":132,"lastTestTime":"...","ip":"1.2.3.4"}
//
// The exact fields have moved around between releases, so the reader takes
// what it recognises and ignores the rest: the tag, the delay in
// milliseconds, and the timestamp. A line that is not one of those is left
// alone, because the same log carries ordinary access records.

/** The last delay seen for each outbound tag. */
export function parseObservatoryLog(text) {
  const result = {};
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const tag = String(payload.outboundTag || payload.tag || "");
    const delay = Number(payload.delay);
    if (!tag || !Number.isFinite(delay)) {
      continue;
    }
    result[tag] = {
      delay,
      time: String(payload.lastTestTime || payload.time || ""),
      error: String(payload.error || payload.lastErrorReason || ""),
      ip: String(payload.ip || ""),
    };
  }
  return result;
}

/** A delay as the panel shows it: milliseconds, or a dash. */
export const formatDelay = (delay) =>
  Number.isFinite(delay) && delay >= 0 ? `${Math.round(delay)} ms` : "—";
