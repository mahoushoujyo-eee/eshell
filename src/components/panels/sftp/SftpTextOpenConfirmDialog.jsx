import { AlertTriangle, FileQuestion, Loader2 } from "lucide-react";
import { useEffect } from "react";

export default function SftpTextOpenConfirmDialog({
  open,
  entry,
  guard,
  busy = false,
  formatBytes,
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

  if (!open || !entry || !guard) {
    return null;
  }

  const fileLabel = entry.name?.trim() || entry.path || "Selected file";
  const sizeLabel =
    typeof formatBytes === "function" ? formatBytes(guard.size || entry.size || 0) : `${guard.size || 0} B`;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-[rgba(26,20,14,0.28)] p-4 backdrop-blur-[2px]"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-lg rounded-[26px] border border-border/85 bg-panel/98 p-5 shadow-[0_28px_80px_rgba(34,26,16,0.22)] ring-1 ring-white/45"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-open-confirm-title"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-warning/25 bg-warning/10 text-warning">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div
              id="sftp-open-confirm-title"
              className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warning/80"
            >
              Text Editor Check
            </div>
            <h3 className="mt-1 text-lg font-semibold text-text">Open this file as text?</h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              <span className="font-medium text-text">{fileLabel}</span> may not be a good fit for the
              built-in text editor.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-border/70 bg-surface/75 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <FileQuestion className="h-4 w-4 text-accent" aria-hidden="true" />
            File details
          </div>
          <div className="mt-2 space-y-1 text-xs text-muted">
            <div>Path: {entry.path}</div>
            <div>Size: {sizeLabel}</div>
          </div>

          <div className="mt-3 space-y-2 text-sm text-muted">
            {guard.reasons.map((reason) => (
              <p key={reason} className="leading-6">
                {reason}
              </p>
            ))}
          </div>
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
            className="inline-flex items-center gap-1.5 rounded-2xl border border-warning/60 bg-warning px-4 py-2 text-sm font-medium text-white shadow-[0_12px_28px_rgba(210,146,42,0.22)] transition-colors hover:bg-[#c98a18] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileQuestion className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Opening..." : "Open Anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
