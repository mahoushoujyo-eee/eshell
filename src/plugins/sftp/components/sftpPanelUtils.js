import { normalizeRemotePath } from "../../../utils/path";

export const getDirectoryNodes = (entries) => {
  const deduped = new Map();
  for (const entry of entries || []) {
    if (entry.entryType !== "directory") {
      continue;
    }
    if (entry.name === "." || entry.name === "..") {
      continue;
    }
    const normalized = normalizeRemotePath(entry.path);
    if (!deduped.has(normalized)) {
      deduped.set(normalized, {
        name: entry.name,
        path: normalized,
      });
    }
  }

  return [...deduped.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
};

export const transferStageLabel = (stage) => {
  switch (stage) {
    case "queued":
      return "Queued";
    case "started":
    case "progress":
      return "Transferring";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
};

export const transferStageColor = (stage) => {
  switch (stage) {
    case "completed":
      return "text-success";
    case "cancelled":
      return "text-warning";
    case "failed":
      return "text-danger";
    case "queued":
      return "text-warning";
    default:
      return "text-accent";
  }
};

export const transferDirectionLabel = (direction) =>
  direction === "upload" ? "Upload" : "Download";
