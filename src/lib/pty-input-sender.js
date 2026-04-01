const defaultSchedule = (fn, delayMs) => setTimeout(fn, delayMs);
const defaultCancelScheduled = (timerId) => clearTimeout(timerId);

export const DEFAULT_PTY_INPUT_FLUSH_DELAY_MS = 12;
export const DEFAULT_PTY_INPUT_MAX_CHUNK_CHARS = 4096;

export function createPtyInputSender(options) {
  const {
    send,
    onError = () => {},
    flushDelayMs = DEFAULT_PTY_INPUT_FLUSH_DELAY_MS,
    maxChunkChars = DEFAULT_PTY_INPUT_MAX_CHUNK_CHARS,
    schedule = defaultSchedule,
    cancelScheduled = defaultCancelScheduled,
  } = options || {};

  if (typeof send !== "function") {
    throw new Error("createPtyInputSender requires a send function");
  }

  const pendingBySession = new Map();
  const timerBySession = new Map();
  const inFlightBySession = new Map();
  let disposed = false;

  const clearSession = (sessionId) => {
    if (!sessionId) {
      return;
    }
    pendingBySession.delete(sessionId);
    inFlightBySession.delete(sessionId);

    const timerId = timerBySession.get(sessionId);
    if (timerId !== undefined) {
      cancelScheduled(timerId);
      timerBySession.delete(sessionId);
    }
  };

  const scheduleFlush = (sessionId, delayMs = flushDelayMs) => {
    if (!sessionId || disposed || timerBySession.has(sessionId)) {
      return;
    }
    const timerId = schedule(() => {
      timerBySession.delete(sessionId);
      void flushSession(sessionId);
    }, Math.max(0, delayMs));
    timerBySession.set(sessionId, timerId);
  };

  const flushSession = async (sessionId) => {
    if (!sessionId || disposed || inFlightBySession.get(sessionId)) {
      return;
    }
    const pending = pendingBySession.get(sessionId);
    if (!pending) {
      return;
    }

    const chunk = pending.slice(0, maxChunkChars);
    const remaining = pending.slice(chunk.length);
    if (remaining) {
      pendingBySession.set(sessionId, remaining);
    } else {
      pendingBySession.delete(sessionId);
    }

    inFlightBySession.set(sessionId, true);
    try {
      await send(sessionId, chunk);
    } catch (error) {
      clearSession(sessionId);
      onError(error);
      return;
    } finally {
      inFlightBySession.delete(sessionId);
    }

    if (disposed) {
      return;
    }

    if (pendingBySession.has(sessionId)) {
      scheduleFlush(sessionId, 0);
    }
  };

  const enqueue = (sessionId, data) => {
    if (!sessionId || !data || disposed) {
      return;
    }
    pendingBySession.set(sessionId, `${pendingBySession.get(sessionId) || ""}${data}`);
    scheduleFlush(sessionId, flushDelayMs);
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    timerBySession.forEach((timerId) => {
      cancelScheduled(timerId);
    });
    timerBySession.clear();
    pendingBySession.clear();
    inFlightBySession.clear();
  };

  return {
    enqueue,
    clearSession,
    dispose,
  };
}
