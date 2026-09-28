import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import Button from "../ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../ui/Dialog";

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

  return (
    <Dialog
      open={Boolean(plugin)}
      onClose={onCancel}
      dismissible={!busy}
      layer="stacked"
      size="sm"
      labelledBy="plugin-remove-title"
    >
      {plugin ? (
        <>
          <DialogHeader
            icon={AlertTriangle}
            tone="danger"
            title={t("Remove this plugin?")}
            titleId="plugin-remove-title"
            description={t("Confirm Remove")}
          />
          <DialogBody className="space-y-3">
            <p className="text-[13px] leading-6 text-muted">
              <span className="font-medium text-text">{plugin.displayName}</span>{" "}
              {t("and its folder will be deleted from disk. This cannot be undone.")}
            </p>
            <div className="rounded-md border border-border bg-panel px-3 py-2">
              <div className="text-[11px] font-medium text-subtle">{t("Plugin")}</div>
              <div className="mt-0.5 font-mono text-xs break-all text-text">{plugin.id}</div>
              <div className="mt-1.5 text-[11px] text-muted">
                {t("To use it again, install it from its folder again.")}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button variant="danger" onClick={onConfirm} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {busy ? t("Removing...") : t("Remove")}
            </Button>
          </DialogFooter>
        </>
      ) : null}
    </Dialog>
  );
}
