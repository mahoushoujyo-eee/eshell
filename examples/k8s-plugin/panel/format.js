// Small formatting helpers shared by the panel.

/** Copies text, ignoring a refused clipboard. */
export const copyText = (value) => {
  navigator.clipboard?.writeText(String(value ?? "")).catch(() => {});
};

/** `kubectl get -o wide` puts the widest columns last; these get more room. */
const WIDE_COLUMNS = new Set(["NAME", "IMAGE", "IMAGES", "MESSAGE", "REASON", "OBJECT", "HOSTS", "ADDRESS", "COMMAND"]);
const NARROW_COLUMNS = new Set([
  "READY",
  "AGE",
  "RESTARTS",
  "PORTS",
  "REPLICAS",
  "DESIRED",
  "CURRENT",
  "UP-TO-DATE",
  "AVAILABLE",
  "SUSPEND",
  "ACTIVE",
  "TYPE",
  "CAPACITY",
  "ACCESS MODES",
  "VERSION",
  "STATUS",
  "PHASE",
  "COMPLETIONS",
  "DURATION",
  "SCHEDULE",
  "DATA",
  "CLASS",
]);

/**
 * A grid track for one column. The first column carries the row's identity and
 * gets the most room; short numeric columns are pinned so the table does not
 * jitter as values change.
 */
export function columnWidth(column, index) {
  const name = String(column ?? "").toUpperCase();
  if (index === 0) {
    return "minmax(160px,1.6fr)";
  }
  if (NARROW_COLUMNS.has(name)) {
    return "minmax(64px,90px)";
  }
  if (WIDE_COLUMNS.has(name)) {
    return "minmax(120px,1.4fr)";
  }
  return "minmax(90px,1fr)";
}

/** The name a command needs for a row, and the namespace it belongs to. */
export const rowTarget = (row) => ({ name: row.name, namespace: row.namespace });

/** A job name for a manual CronJob run: what `kubectl create job` expects. */
export const manualJobName = (cronjob) =>
  `${String(cronjob).slice(0, 40)}-manual-${Math.floor(Date.now() / 1000)
    .toString()
    .slice(-6)}`;
