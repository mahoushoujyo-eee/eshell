import { useCallback, useRef } from "react";
import { useI18n } from "../../lib/i18n";
import { STATUS_FETCH_WARNING_PREFIX } from "../../hooks/workbench/errors";

/**
 * Server status operations, moved verbatim from `hooks/workbench/operations.js`.
 *
 * Polling order matters: the cached snapshot is written first, the live one
 * second, so a slow live fetch cannot overwrite fresher cached data with
 * stale UI. The per-session Symbol token deduplicates overlapping requests:
 * when a newer poll starts, the older one's result is dropped on arrival.
 *
 * Callback identity is stable (latest-ref context): the polling effect can
 * depend on `refreshStatus` alone without re-subscribing whenever unrelated
 * workbench state changes — and a status snapshot landing in state does not
 * restart the poll interval.
 */
export function useStatusOperations(ctx) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const refreshStatus = useCallback(async (sessionId, nic) => {
    const current = ctxRef.current;
    if (!sessionId) {
      return;
    }
    const resolvedSessionId = current.resolveSessionAlias(sessionId) || sessionId;
    const requestedNic = typeof nic === "string" && nic.trim() ? nic : null;
    const requestToken = Symbol(resolvedSessionId);
    const statusWarningMessage = tRef.current(STATUS_FETCH_WARNING_PREFIX);
    current.statusRequestTokenRef.current.set(resolvedSessionId, requestToken);

    try {
      const statusResult = await current.runWithSessionReconnect(
        resolvedSessionId,
        async (activeId) => {
          const cached = await current.api.status.cached(activeId);
          const live = await current.api.status.fetch(activeId, requestedNic);
          return {
            activeId,
            cached,
            live,
          };
        },
      );

      const tokenKey = statusResult.activeId || resolvedSessionId;
      const latestToken =
        current.statusRequestTokenRef.current.get(tokenKey) ??
        current.statusRequestTokenRef.current.get(resolvedSessionId);
      if (latestToken !== requestToken) {
        return;
      }
      if (statusResult.activeId !== resolvedSessionId) {
        current.statusRequestTokenRef.current.set(statusResult.activeId, requestToken);
      }

      if (statusResult.cached) {
        current.setStatusBySession((prev) => ({
          ...prev,
          [statusResult.activeId]: statusResult.cached,
        }));
      }
      current.setStatusBySession((prev) => ({
        ...prev,
        [statusResult.activeId]: statusResult.live,
      }));

      // Respect explicit user selection and only auto-pick NIC when no preference is provided.
      if (!requestedNic && statusResult.live.selectedInterface) {
        current.setNicBySession((prev) => ({
          ...prev,
          [statusResult.activeId]: statusResult.live.selectedInterface,
        }));
      }

      current.setError((prev) => {
        const currentMessage = typeof prev === "string" ? prev.trim() : "";
        return currentMessage === STATUS_FETCH_WARNING_PREFIX ||
          currentMessage === statusWarningMessage
          ? ""
          : prev;
      });
    } catch (err) {
      current.setError((prev) => {
        const currentMessage = typeof prev === "string" ? prev.trim() : "";
        if (
          currentMessage &&
          currentMessage !== STATUS_FETCH_WARNING_PREFIX &&
          currentMessage !== statusWarningMessage
        ) {
          return prev;
        }
        return statusWarningMessage;
      });
    }
  }, []);

  const handleNicChange = useCallback(
    (nic) => {
      const current = ctxRef.current;
      if (!current.activeSessionId) {
        return;
      }
      const targetSessionId =
        current.resolveSessionAlias(current.activeSessionId) || current.activeSessionId;
      current.setNicBySession((prev) => ({ ...prev, [targetSessionId]: nic }));
      refreshStatus(targetSessionId, nic);
    },
    [refreshStatus],
  );

  return { refreshStatus, handleNicChange };
}
