import { useCallback } from "react";

/**
 * Port-forward operations: every backend call the panel makes.
 *
 * Each one refreshes the affected tab's rows from the backend rather than
 * patching local state, because the backend owns the truth about bound ports
 * (a `bindPort` of 0 comes back as whatever the OS assigned) and about
 * forwards that failed on their own.
 */
export function useForwardOperations(ctx) {
  const { api, activeSessionId, onError, setSessionForwards, setLoadError } = ctx;

  const forwardApi = api?.forward;

  /** Re-reads the rows for one tab. Never throws; a failure surfaces in the panel. */
  const refreshForwards = useCallback(
    async (sessionId = activeSessionId) => {
      if (!forwardApi || !sessionId) {
        return [];
      }
      try {
        const rows = await forwardApi.list(sessionId);
        setSessionForwards(sessionId, Array.isArray(rows) ? rows : []);
        setLoadError(null);
        return rows;
      } catch (error) {
        setLoadError(error);
        return [];
      }
    },
    [forwardApi, activeSessionId, setSessionForwards, setLoadError],
  );

  const createForward = useCallback(
    async ({ targetHost, targetPort, bindHost, bindPort }) => {
      if (!forwardApi || !activeSessionId) {
        return false;
      }
      try {
        await forwardApi.create({
          sessionId: activeSessionId,
          targetHost,
          targetPort,
          bindHost,
          bindPort,
        });
      } catch (error) {
        onError?.(error);
        return false;
      }
      await refreshForwards(activeSessionId);
      return true;
    },
    [forwardApi, activeSessionId, onError, refreshForwards],
  );

  const stopForward = useCallback(
    async (forwardId) => {
      if (!forwardApi || !forwardId) {
        return false;
      }
      try {
        await forwardApi.stop(forwardId);
      } catch (error) {
        onError?.(error);
        return false;
      }
      await refreshForwards(activeSessionId);
      return true;
    },
    [forwardApi, activeSessionId, onError, refreshForwards],
  );

  const forgetForward = useCallback(
    async (forwardId) => {
      if (!forwardApi || !forwardId) {
        return false;
      }
      try {
        await forwardApi.forget(forwardId);
      } catch (error) {
        onError?.(error);
        return false;
      }
      await refreshForwards(activeSessionId);
      return true;
    },
    [forwardApi, activeSessionId, onError, refreshForwards],
  );

  return { refreshForwards, createForward, stopForward, forgetForward };
}
