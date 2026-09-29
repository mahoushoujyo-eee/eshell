/**
 * Startup timeline, for answering "where does the wait go?" with numbers.
 *
 * Each milestone is stamped with the page's own clock — `performance.now()`
 * counts from navigation start — and, under `tauri dev`, forwarded to the
 * native side, which prints it next to its own milestones. One terminal, one
 * merged list, no cross-referencing two logs:
 *
 *   [boot +  212ms] native page load Started http://localhost:1420/
 *   [boot +  420ms] page   splash painted (page +96ms)
 *   [boot + 4310ms] page   modules loaded (page +3990ms)
 *   ...
 *
 * Production builds keep the marks (they are a few bytes) but neither log nor
 * forward them.
 */

const marks = [];

/** Records one milestone. Never throws: tracing must not be able to break boot. */
export function bootMark(stage) {
  const pageMs = typeof performance === "undefined" ? 0 : Math.round(performance.now());
  marks.push({ stage, pageMs });
  if (!import.meta.env?.DEV) {
    return;
  }
  try {
    console.info(`[boot +${pageMs}ms] ${stage}`);
    const tauri = typeof window === "undefined" ? null : window.__TAURI_INTERNALS__;
    const pending = tauri?.invoke?.("boot_trace", { stage, pageMs });
    pending?.catch?.(() => {});
  } catch {
    // Tracing is best-effort.
  }
}

/** The milestones recorded so far, in order. A copy: callers cannot mutate history. */
export function listBootMarks() {
  return marks.map((mark) => ({ ...mark }));
}
