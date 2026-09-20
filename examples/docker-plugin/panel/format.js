// Small formatting helpers shared by the panel's rows and tabs.

const STATE_TONE = {
  running: "success",
  paused: "warning",
  restarting: "info",
  created: "neutral",
  removing: "warning",
  exited: "neutral",
  dead: "danger",
};

export const stateTone = (state) => STATE_TONE[state] || "neutral";

export const shortId = (value) =>
  String(value ?? "")
    .replace(/^sha256:/, "")
    .slice(0, 12);

export const meterTone = (percent) =>
  percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-warning" : "bg-accent";

/** `docker info` reports MemTotal in bytes. */
export function humanBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = numeric;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** An ISO stamp trimmed to something that fits a table cell. */
export const shortTime = (value) =>
  String(value ?? "")
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");

export const splitLines = (value) =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Copies text, ignoring a refused clipboard. */
export const copyText = (value) => {
  navigator.clipboard?.writeText(String(value ?? "")).catch(() => {});
};
