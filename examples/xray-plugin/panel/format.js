// Formatting helpers for the panel.

/** A timestamp as the user's locale writes it. */
export const formatTime = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "—";
  }
  try {
    return new Date(numeric).toLocaleString();
  } catch {
    return "—";
  }
};

/** How long ago something happened, in words. */
export function formatAgo(value, t) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return t("never");
  }
  const seconds = Math.max(0, Math.round((Date.now() - numeric) / 1000));
  if (seconds < 60) {
    return t("just now");
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return t("{n} min ago", { n: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t("{n} h ago", { n: hours });
  }
  return t("{n} d ago", { n: Math.round(hours / 24) });
}
