export const toErrorMessage = (err) =>
  typeof err === "string" ? err : err?.message || JSON.stringify(err);

export const STATUS_FETCH_WARNING_PREFIX =
  "Warning: Server status polling failed for this cycle due to a transient network fluctuation. The app will retry automatically.";

export const isStatusFetchWarning = (message) =>
  typeof message === "string" && message.startsWith(STATUS_FETCH_WARNING_PREFIX);

/// True when the tab itself is gone, so nothing can be recovered on it.
///
/// `remove_session` is the only thing that produces these, and it drops the
/// session record, its cancellation token and its cached connection together.
/// The frontend must surface this instead of retrying: reopening a PTY against
/// a removed tab fails the same way every time.
export const isSessionGoneError = (err) => {
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("record not found: shell session") ||
    message.includes("shell session closed")
  );
};

/// True when only the tab's PTY worker died and the tab is still registered.
///
/// The session record survives a dead worker (`pty.rs` keeps it deliberately so
/// the tab keeps its identity), which is what makes `reopen_shell_pty` able to
/// rebuild the channel against the same session id. These are the only errors
/// worth recovering from, and the recovery is a PTY reopen — never a new session.
export const isPtyLostError = (err) => {
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("record not found: pty session") ||
    message.includes("pty worker channel closed") ||
    message.includes("pty channel closed while writing")
  );
};
