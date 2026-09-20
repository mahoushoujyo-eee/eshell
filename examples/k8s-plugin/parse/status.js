// Reading meaning out of a kubectl table cell.
//
// The table is text, so the panel decides what is healthy from the same strings
// a human reads. The phrase lists are kubelet/controller reasons, not a guess:
// they are what shows up in the STATUS column of `kubectl get pods`.

const GOOD = [
  "running",
  "ready",
  "active",
  "bound",
  "succeeded",
  "completed",
  "available",
  "healthy",
  "true",
];

const BUSY = [
  "pending",
  "containercreating",
  "podinitializing",
  "terminating",
  "init:",
  "progressing",
  "scheduling",
  "released",
  "notready,schedulingdisabled",
  "ready,schedulingdisabled",
  "suspended",
];

const BAD = [
  "error",
  "failed",
  "crashloopbackoff",
  "imagepullbackoff",
  "errimagepull",
  "createcontainererror",
  "createcontainerconfigerror",
  "invalidimagename",
  "oomkilled",
  "evicted",
  "notready",
  "unknown",
  "unschedulable",
  "backoff",
  "outofpods",
  "deadlineexceeded",
  "lost",
];

const matches = (value, phrases) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return false;
  }
  return phrases.some((phrase) => text === phrase || text.includes(phrase));
};

/** `2/3` → `{ ready: 2, total: 3 }`; anything else → null. */
export function readyFraction(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? "").trim());
  if (!match) {
    return null;
  }
  return { ready: Number(match[1]), total: Number(match[2]) };
}

/** `3 (5m ago)` → 3. */
export function restartCount(value) {
  const match = /^(\d+)/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** The tone for one cell, by column name. `null` means "no opinion". */
export function cellTone(column, value) {
  const name = String(column ?? "").toUpperCase();

  if (name === "READY" || name === "UP-TO-DATE" || name === "COMPLETIONS") {
    const fraction = readyFraction(value);
    if (!fraction) {
      return matches(value, GOOD) ? "success" : null;
    }
    if (fraction.total === 0) {
      return "neutral";
    }
    return fraction.ready === fraction.total ? "success" : "warning";
  }

  if (name === "RESTARTS") {
    const count = restartCount(value);
    if (count === null) {
      return null;
    }
    return count === 0 ? null : count >= 5 ? "danger" : "warning";
  }

  if (name === "STATUS" || name === "STATE" || name === "PHASE" || name === "CONDITION") {
    // Checked worst-first: "NotReady" contains "Ready", and
    // "Init:CrashLoopBackOff" is a failure, not a startup step.
    if (matches(value, BAD)) {
      return "danger";
    }
    if (matches(value, BUSY)) {
      return "warning";
    }
    return matches(value, GOOD) ? "success" : null;
  }

  if (name === "SUSPEND") {
    return String(value).trim().toLowerCase() === "true" ? "warning" : null;
  }

  return null;
}

/**
 * The tone of the row's leading dot: the worst opinion any of its cells has.
 * A row with nothing to say about itself gets the neutral dot.
 */
export function rowTone(row) {
  const order = { danger: 3, warning: 2, success: 1, neutral: 0 };
  let best = "neutral";
  for (const [column, value] of Object.entries(row.byName || {})) {
    const tone = cellTone(column, value);
    if (tone && order[tone] > order[best]) {
      best = tone;
    }
  }
  return best;
}

/** Columns worth hiding by default: long, rarely read, and usually `<none>`. */
const NOISY = new Set(["NOMINATED NODE", "READINESS GATES", "SELECTOR", "LABELS", "ANNOTATIONS"]);

export const isNoisyColumn = (column) => NOISY.has(String(column ?? "").toUpperCase());

/** `<none>` and `<unknown>` are kubectl's placeholders; show them as a dash. */
export const displayCell = (value) => {
  const text = String(value ?? "").trim();
  return text === "" || text === "<none>" || text === "<unknown>" ? "—" : text;
};
