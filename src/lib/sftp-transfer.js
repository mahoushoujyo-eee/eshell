const VALID_DIRECTIONS = new Set(["upload", "download"]);
const VALID_STAGES = new Set(["queued", "started", "progress", "completed", "failed", "cancelled"]);

const toFiniteNumber = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const clampPercent = (value) => {
  const numeric = toFiniteNumber(value, 0);
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 100) {
    return 100;
  }
  return numeric;
};

export const normalizeSftpTransferEvent = (payload) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const transferId = String(payload.transferId || "").trim();
  if (!transferId) {
    return null;
  }

  const direction = String(payload.direction || "").toLowerCase();
  const stage = String(payload.stage || "").toLowerCase();
  const transferredBytes = Math.max(0, Math.floor(toFiniteNumber(payload.transferredBytes, 0)));
  const totalBytesRaw = toFiniteNumber(payload.totalBytes, NaN);
  const totalBytes =
    Number.isFinite(totalBytesRaw) && totalBytesRaw >= 0 ? Math.floor(totalBytesRaw) : null;
  const fallbackPercent =
    totalBytes && totalBytes > 0 ? (transferredBytes / totalBytes) * 100 : 0;

  return {
    transferId,
    sessionId: String(payload.sessionId || "").trim(),
    direction: VALID_DIRECTIONS.has(direction) ? direction : "download",
    stage: VALID_STAGES.has(stage) ? stage : "progress",
    remotePath: String(payload.remotePath || "").trim(),
    localPath:
      typeof payload.localPath === "string" && payload.localPath.trim()
        ? payload.localPath.trim()
        : "",
    fileName: String(payload.fileName || "").trim() || "unknown",
    transferredBytes,
    totalBytes,
    percent: clampPercent(toFiniteNumber(payload.percent, fallbackPercent)),
    message:
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "",
    updatedAt: Date.now(),
  };
};

export const createSftpTransferSeed = ({
  transferId,
  sessionId,
  direction,
  remotePath,
  localPath = "",
  fileName,
  totalBytes = null,
}) => normalizeSftpTransferEvent({
  transferId,
  sessionId,
  direction,
  stage: "queued",
  remotePath,
  localPath,
  fileName,
  transferredBytes: 0,
  totalBytes,
  percent: 0,
  message: "",
});

export const upsertSftpTransfer = (rows, incoming, maxRows = 30) => {
  const event = normalizeSftpTransferEvent(incoming);
  if (!event) {
    return rows;
  }

  const list = Array.isArray(rows) ? rows : [];
  const next = [...list];
  const index = next.findIndex((item) => item.transferId === event.transferId);
  if (index >= 0) {
    const previous = next[index];
    next[index] = {
      ...previous,
      ...event,
      percent:
        event.stage === "completed"
          ? 100
          : clampPercent(Math.max(previous.percent || 0, event.percent)),
    };
  } else {
    next.unshift(event);
  }

  next.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  return next.slice(0, Math.max(1, maxRows));
};
