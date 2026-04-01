export const toErrorMessage = (err) =>
  typeof err === "string" ? err : err?.message || JSON.stringify(err);

export const STATUS_FETCH_WARNING_PREFIX =
  "Warning: Server status polling failed for this cycle due to a transient network fluctuation. The app will retry automatically.";

export const isStatusFetchWarning = (message) =>
  typeof message === "string" && message.startsWith(STATUS_FETCH_WARNING_PREFIX);

export const isSessionLostError = (err) => {
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("record not found: shell session") ||
    message.includes("record not found: pty session") ||
    message.includes("pty worker channel closed") ||
    message.includes("pty channel closed while writing")
  );
};
