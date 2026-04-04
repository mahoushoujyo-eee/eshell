import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useEffect } from "react";

export default function SftpDeleteConfirmDialog({
  open,
  entry,
  busy = false,
  onCancel,
  onConfirm,
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, open]);

  if (!open || !entry) {
    return null;
  }

  const fileLabel = entry.name?.trim() || entry.path || "Selected file";
  const isDirectory = entry.entryType === "directory";

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-[rgba(26,20,14,0.28)] p-4 backdrop-blur-[2px]"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-md rounded-[26px] border border-border/85 bg-panel/98 p-5 shadow-[0_28px_80px_rgba(34,26,16,0.22)] ring-1 ring-white/45"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-delete-confirm-title"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-danger/20 bg-danger/10 text-danger">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div
              id="sftp-delete-confirm-title"
              className="text-[10px] font-semibold uppercase tracking-[0.22em] text-danger/75"
            >
              Confirm Delete
            </div>
            <h3 className="mt-1 text-lg font-semibold text-text">
              {isDirectory ? "Delete this remote folder?" : "Delete this remote file?"}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              <span className="font-medium text-text">{fileLabel}</span>{" "}
              {isDirectory
                ? "and everything inside it will be removed from the remote server immediately."
                : "will be removed from the remote server immediately."}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-border/70 bg-surface/75 p-3 text-xs text-muted">
          <div className="font-medium text-text">Path</div>
          <div className="mt-1 break-all">{entry.path}</div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-border/80 bg-surface px-4 py-2 text-sm text-muted transition-colors hover:bg-warm disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-danger/60 bg-danger px-4 py-2 text-sm font-medium text-white shadow-[0_12px_28px_rgba(194,72,50,0.22)] transition-colors hover:bg-[#b53f2b] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
