const MAX_RECENT_EVENTS = 160;
const SUMMARY_INTERVAL_MS = 2000;

const debugState = {
  sessions: new Map(),
  recentEvents: [],
  consoleEnabled: false,
  lastSummaryAt: 0,
};

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function ensureSessionStats(sessionId) {
  const key = sessionId || "unknown";
  let stats = debugState.sessions.get(key);
  if (!stats) {
    stats = {
      sessionId: key,
      ptyEvents: 0,
      ptyBytes: 0,
      maxChunkBytes: 0,
      outputUpdates: 0,
      outputBufferLength: 0,
      trimResets: 0,
      maxOutputUpdateMs: 0,
      xtermWrites: 0,
      xtermWriteBytes: 0,
      resizeEvents: 0,
      lastResizeSource: "",
      lastResizeCols: 0,
      lastResizeRows: 0,
      lastActivityAt: Date.now(),
    };
    debugState.sessions.set(key, stats);
  }
  stats.lastActivityAt = Date.now();
  return stats;
}

function pushRecentEvent(kind, payload) {
  debugState.recentEvents.push({
    at: new Date().toISOString(),
    kind,
    ...payload,
  });
  if (debugState.recentEvents.length > MAX_RECENT_EVENTS) {
    debugState.recentEvents.splice(0, debugState.recentEvents.length - MAX_RECENT_EVENTS);
  }
}

function getSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    consoleEnabled: debugState.consoleEnabled,
    sessions: Array.from(debugState.sessions.values())
      .map((stats) => ({ ...stats }))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt),
    recentEvents: [...debugState.recentEvents],
  };
}

function maybeLogSummary(reason) {
  if (!debugState.consoleEnabled) {
    return;
  }
  const current = nowMs();
  if (current - debugState.lastSummaryAt < SUMMARY_INTERVAL_MS) {
    return;
  }
  debugState.lastSummaryAt = current;

  const snapshot = getSnapshot();
  const compact = snapshot.sessions.map((stats) => ({
    sessionId: stats.sessionId,
    ptyEvents: stats.ptyEvents,
    ptyKB: Math.round(stats.ptyBytes / 1024),
    maxChunkBytes: stats.maxChunkBytes,
    outputUpdates: stats.outputUpdates,
    outputBufferLength: stats.outputBufferLength,
    maxOutputUpdateMs: Number(stats.maxOutputUpdateMs.toFixed(2)),
    xtermWrites: stats.xtermWrites,
    xtermKB: Math.round(stats.xtermWriteBytes / 1024),
    resizeEvents: stats.resizeEvents,
    lastResizeSource: stats.lastResizeSource,
  }));

  console.debug("[eshell][terminal-perf]", reason, compact);
}

function installGlobalApi() {
  if (typeof window === "undefined") {
    return;
  }

  window.__eshellDebug = {
    ...(window.__eshellDebug || {}),
    getTerminalPerfSnapshot: () => getSnapshot(),
    clearTerminalPerfSnapshot: () => {
      debugState.sessions.clear();
      debugState.recentEvents = [];
      debugState.lastSummaryAt = 0;
      return getSnapshot();
    },
    setTerminalPerfConsole: (enabled = true) => {
      debugState.consoleEnabled = Boolean(enabled);
      return debugState.consoleEnabled;
    },
    helpTerminalPerf: () => [
      "window.__eshellDebug.getTerminalPerfSnapshot()",
      "window.__eshellDebug.clearTerminalPerfSnapshot()",
      "window.__eshellDebug.setTerminalPerfConsole(true)",
    ],
  };
}

export function recordPtyChunk(sessionId, chunkLength) {
  installGlobalApi();
  const stats = ensureSessionStats(sessionId);
  stats.ptyEvents += 1;
  stats.ptyBytes += chunkLength;
  stats.maxChunkBytes = Math.max(stats.maxChunkBytes, chunkLength);
  pushRecentEvent("pty-chunk", {
    sessionId: stats.sessionId,
    chunkLength,
  });
  maybeLogSummary("pty-chunk");
}

export function recordOutputBufferUpdate(sessionId, previousLength, chunkLength, nextLength, durationMs) {
  installGlobalApi();
  const stats = ensureSessionStats(sessionId);
  stats.outputUpdates += 1;
  stats.outputBufferLength = nextLength;
  stats.maxOutputUpdateMs = Math.max(stats.maxOutputUpdateMs, durationMs);
  if (nextLength < previousLength) {
    stats.trimResets += 1;
  }
  if (durationMs >= 8) {
    pushRecentEvent("slow-output-update", {
      sessionId: stats.sessionId,
      previousLength,
      chunkLength,
      nextLength,
      durationMs: Number(durationMs.toFixed(2)),
    });
  }
  maybeLogSummary(durationMs >= 8 ? "slow-output-update" : "output-update");
}

export function recordXtermWrite(sessionId, deltaLength, totalLength) {
  installGlobalApi();
  const stats = ensureSessionStats(sessionId);
  stats.xtermWrites += 1;
  stats.xtermWriteBytes += deltaLength;
  stats.outputBufferLength = totalLength;
  maybeLogSummary("xterm-write");
}

export function recordTerminalResize(sessionId, cols, rows, source) {
  installGlobalApi();
  const stats = ensureSessionStats(sessionId);
  stats.resizeEvents += 1;
  stats.lastResizeSource = source || "";
  stats.lastResizeCols = cols || 0;
  stats.lastResizeRows = rows || 0;
  if (stats.resizeEvents % 25 === 0) {
    pushRecentEvent("resize-burst", {
      sessionId: stats.sessionId,
      resizeEvents: stats.resizeEvents,
      cols,
      rows,
      source,
    });
  }
  maybeLogSummary("resize");
}

installGlobalApi();
