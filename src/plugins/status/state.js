import { useCallback, useRef, useState } from "react";

/**
 * Server-monitor-owned workbench state, moved verbatim from
 * `hooks/useWorkbench.js` (same defaults, same initializer order, same
 * `eshell:status-refresh-interval` localStorage key).
 */
export function useStatusState() {
  const [statusBySession, setStatusBySession] = useState({});
  const [nicBySession, setNicBySession] = useState({});
  const [statusRefreshInterval, setStatusRefreshInterval] = useState(() => {
    if (typeof window === "undefined") return 5000;
    return (
      parseInt(
        window.localStorage.getItem("eshell:status-refresh-interval") || "5000",
        10,
      ) || 5000
    );
  });

  // Per-session in-flight request tokens; the Symbol identity is what drops
  // an overlapping poll's stale result, so the ref lives with the plugin.
  const statusRequestTokenRef = useRef(new Map());

  const clearSessionTokens = useCallback(
    (sessionId) => {
      statusRequestTokenRef.current.delete(sessionId);
    },
    [],
  );

  return {
    statusBySession,
    setStatusBySession,
    nicBySession,
    setNicBySession,
    statusRefreshInterval,
    setStatusRefreshInterval,
    statusRequestTokenRef,
    clearSessionTokens,
  };
}

/**
 * `currentStatus` / `currentNic` derivations, moved verbatim: the active
 * session's latest snapshot and its selected NIC (null when none).
 */
export const deriveCurrentStatus = ({ activeSessionId, statusBySession }) =>
  activeSessionId ? statusBySession[activeSessionId] : null;

export const deriveCurrentNic = ({ activeSessionId, nicBySession }) =>
  activeSessionId ? nicBySession[activeSessionId] || null : null;
