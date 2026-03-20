export const SHELL_CONTEXT_MAX_CHARS = 4000;
export const SHELL_CONTEXT_PREVIEW_CHARS = 72;

const truncateText = (value, limit) => {
  const chars = Array.from(value);
  if (chars.length <= limit) {
    return value;
  }
  return `${chars.slice(0, limit).join("")}...`;
};

export const normalizeShellContextContent = (
  value,
  maxChars = SHELL_CONTEXT_MAX_CHARS,
) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return truncateText(trimmed, maxChars);
};

export const formatShellContextPreview = (
  value,
  maxChars = SHELL_CONTEXT_PREVIEW_CHARS,
) => {
  const normalized = normalizeShellContextContent(value, SHELL_CONTEXT_MAX_CHARS);
  if (!normalized) {
    return "";
  }

  const compact = normalized.replace(/\s+/g, " ").trim();
  return truncateText(compact, maxChars);
};

export const normalizeShellContextAttachment = (value = {}) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const normalizedContent = normalizeShellContextContent(value.content);
  if (!normalizedContent) {
    return null;
  }

  return {
    sessionId:
      typeof value.sessionId === "string" && value.sessionId.trim()
        ? value.sessionId.trim()
        : null,
    sessionName:
      typeof value.sessionName === "string" && value.sessionName.trim()
        ? value.sessionName.trim()
        : "Shell",
    content: normalizedContent,
    preview: formatShellContextPreview(normalizedContent),
    charCount: Array.from(normalizedContent).length,
  };
};

export const createShellContextAttachment = (value) =>
  normalizeShellContextAttachment(value);
