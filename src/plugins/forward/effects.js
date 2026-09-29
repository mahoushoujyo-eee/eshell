import { useEffect, useRef } from "react";

/**
 * Port-forward effects.
 *
 * The only background work is keeping the active tab's rows fresh: forwards can
 * end on their own (the transport dies, the server drops the connection), and
 * the panel should not keep showing a stale `Active`. The refresh is a plain
 * interval rather than a push, because a forward's byte counters change on
 * every tunnel and a push would be a firehose for a panel nobody is watching.
 *
 * Polling stops while the panel is hidden, and the handler reads live values
 * through a ref so an unrelated re-render never re-binds the interval.
 */
const POLL_INTERVAL_MS = 3000;

export function useForwardEffects(ctx, operations) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const operationsRef = useRef(operations);
  operationsRef.current = operations;

  const { activeSessionId, panelVisible } = ctx;

  useEffect(() => {
    if (!panelVisible || !activeSessionId) {
      return undefined;
    }

    // Load immediately on open / tab switch, then settle into the interval.
    void operationsRef.current.refreshForwards(activeSessionId);

    const timer = setInterval(() => {
      void operationsRef.current.refreshForwards(ctxRef.current.activeSessionId);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [activeSessionId, panelVisible]);
}
