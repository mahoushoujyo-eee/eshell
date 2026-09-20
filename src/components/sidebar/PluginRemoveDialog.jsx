import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useI18n } from "../../lib/i18n";

/**
 * Confirmation for removing an installed plugin.
 *
 * Removal deletes the plugin's directory from disk and cannot be undone, so
 * it gets a dialog rather than an in-place button swap: the row stays
 * readable while the user decides, and the consequence (the folder is gone,
 * reinstall means picking it again) is stated where the decision is made.
 *
 * Mirrors the SFTP delete dialog's shape so destructive confirmations look
 * the same across the app.
 */
export default function PluginRemoveDialog({ plugin, busy = false, onCancel, onConfirm }) {
  const { t } = useI18n();

  useEffect(() => {
    if (!plugin) {
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
  }, [busy, onCancel, plugin]);

  if (!plugin) {
    return null;
  }

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
        aria-labelledby="plugin-remove-title"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-danger/20 bg-danger/10 text-danger">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div
              id="plugin-remove-title"
              className="text-[10px] font-semibold uppercase tracking-[0.22em] text-danger/75"
            >
              {t("Confirm Remove")}
            </div>
            <h3 className="mt-1 text-lg font-semibold text-text">
              {t("Remove this plugin?")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              <span className="font-medium text-text">{plugin.displayName}</span>{" "}
              {t("and its folder will be deleted from disk. This cannot be undone.")}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-border/70 bg-surface/75 p-3 text-xs text-muted">
          <div className="font-medium text-text">{t("Plugin")}</div>
          <div className="mt-1 break-all">{plugin.id}</div>
          <div className="mt-2 text-[11px]">
            {t("To use it again, install it from its folder again.")}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-border/80 bg-surface px-4 py-2 text-sm text-muted transition-colors hover:bg-warm disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onCancel}
            disabled={busy}
          >
            {t("Cancel")}
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
            {busy ? t("Removing...") : t("Remove")}
          </button>
        </div>
      </div>
    </div>
  );
}
