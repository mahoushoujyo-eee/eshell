export function splitPath(path) {
  const normalized = normalizeRemotePath(path);
  const chunks = normalized.split("/").filter(Boolean);
  const rows = [{ label: "/", path: "/" }];
  let current = "";
  for (const chunk of chunks) {
    current += `/${chunk}`;
    rows.push({ label: chunk, path: current || "/" });
  }
  return rows;
}

export function joinPath(base, fileName) {
  const normalizedBase = normalizeRemotePath(base);
  if (normalizedBase === "/") {
    return normalizeRemotePath(`/${fileName}`);
  }
  return normalizeRemotePath(`${normalizedBase.replace(/\/+$/, "")}/${fileName}`);
}

export function normalizeRemotePath(path) {
  const raw = String(path || "").trim();
  if (!raw) {
    return "/";
  }

  let normalized = raw.replace(/\\/g, "/");
  normalized = normalized.replace(/\/{2,}/g, "/");

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized || "/";
}
