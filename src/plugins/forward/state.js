import { useCallback, useState } from "react";

/**
 * Port-forward-owned workbench state: the row list, the in-flight flags and
 * the dialog target.
 *
 * Rows are keyed by shell tab (`forward.sessionId`), so switching tabs is a
 * filter rather than a refetch — the panel always shows the forwards of the
 * tab you are looking at, and the list survives a tab switch.
 */
export function useForwardState() {
  /** `{ [sessionId]: PortForward[] }` — every forward the backend knows about. */
  const [forwardsBySession, setForwardsBySession] = useState({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  /** Row id whose stop is in flight, so its button can spin/disable. */
  const [stoppingId, setStoppingId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  /** Replaces the rows for one tab, leaving other tabs untouched. */
  const setSessionForwards = useCallback((sessionId, rows) => {
    setForwardsBySession((prev) => ({ ...prev, [sessionId]: rows }));
  }, []);

  const clearSession = useCallback((sessionId) => {
    setForwardsBySession((prev) => {
      if (!(sessionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  return {
    forwardsBySession,
    setSessionForwards,
    clearSession,
    createOpen,
    setCreateOpen,
    createBusy,
    setCreateBusy,
    stoppingId,
    setStoppingId,
    loadError,
    setLoadError,
  };
}

/** The rows for the active tab, or an empty list when nothing is known yet. */
export const selectSessionForwards = (forwardsBySession, sessionId) =>
  (sessionId && forwardsBySession[sessionId]) || [];
