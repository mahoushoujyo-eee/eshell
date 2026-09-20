import { useEffect, useRef } from "react";

/**
 * Server status effects, moved verbatim from `hooks/workbench/effects.js`.
 *
 * The original polling condition is preserved exactly: poll while either the
 * SFTP or status panel is visible (SFTP shows a status chip), stop otherwise,
 * and skip a disconnected session until its PTY is rebuilt.
 *
 * `enabled` only ever *narrows* polling: it is true unless the extension was
 * explicitly disabled, so the default behavior (both panels enabled) is
 * byte-identical.
 *
 * First refresh fires immediately; the gap between polls follows the
 * configured `statusRefreshInterval`, clamped to >= 3000ms with a 5000ms
 * fallback.
 *
 * The gap is measured from the *end* of one poll to the start of the next, not
 * from start to start. A `setInterval` fires on a fixed cadence regardless of
 * whether the previous poll finished, so on a slow link (a poll is five
 * sequential SSH commands and takes longer than the interval) requests pile up
 * without bound: every one of them opens its own channels and re-runs every
 * probe, which slows the link further, and every result but the last is dropped
 * by the request token in operations — the panel freezes while the backend is
 * hammered. Waiting for completion makes the effective period
 * `interval + poll duration`, so a poll can never overlap itself.
 *
 * Dependency stability: the effect depends on the scalar gates and on
 * `refreshStatus` (whose identity is stable — see operations). A status
 * snapshot landing in `statusBySession` re-renders the workbench but does NOT
 * restart this effect, so the poll cadence never feeds back into itself.
 * `currentNic` is read through a latest-ref so a NIC change re-polls on the
 * next tick without tearing the loop down.
 */
export function useStatusEffects(ctx, statusOps) {
  // Latest-ref reads: everything the interval callback needs at fire time.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const statusOpsRef = useRef(statusOps);
  statusOpsRef.current = statusOps;

  useEffect(() => {
    if (!ctx.activeSessionId) {
      return undefined;
    }
    if (!ctx.statusEnabled) {
      return undefined;
    }

    const shouldPollStatus = ctx.showSftpPanel || ctx.showStatusPanel;
    if (!shouldPollStatus) {
      return undefined;
    }
    // A disconnected session has no backend state to poll; resume after reconnect.
    if (ctx.disconnectedSessions[ctx.activeSessionId]) {
      return undefined;
    }

    const currentSessionId = ctx.activeSessionId;
    const currentNic = ctx.currentNic;

    const interval =
      typeof ctx.statusRefreshInterval === "number" && ctx.statusRefreshInterval >= 3000
        ? ctx.statusRefreshInterval
        : 5000;

    // Self-scheduling loop: the next poll is armed only after the current one
    // settles, so a poll slower than `interval` delays the next tick instead of
    // overlapping with it. `cancelled` is checked after the await because the
    // effect can be torn down while a poll is still in flight.
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      if (cancelled) {
        return;
      }
      try {
        await statusOpsRef.current.refreshStatus(
          currentSessionId,
          ctxRef.current.currentNic,
        );
      } catch {
        // refreshStatus reports its own failures through the workbench error
        // state; a rejected poll must not stop the loop.
      }
      if (cancelled) {
        return;
      }
      timer = setTimeout(poll, interval);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    // Scalar gates only: a status write re-renders the workbench without
    // re-running this effect (it is not in the deps), which is what keeps
    // "poll -> state update -> poll" from becoming a tight loop.
  }, [
    ctx.activeSessionId,
    ctx.currentNic,
    ctx.disconnectedSessions,
    ctx.showSftpPanel,
    ctx.showStatusPanel,
    ctx.statusEnabled,
    ctx.statusRefreshInterval,
  ]);
}
