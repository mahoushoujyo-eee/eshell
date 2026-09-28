import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button from "../../../components/ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../../../components/ui/Dialog";

export default function SftpDeleteConfirmDialog({
  open,
  entry,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const { t } = useI18n();

  const fileLabel = entry?.name?.trim() || entry?.path || t("Selected file");
  const isDirectory = entry?.entryType === "directory";

  return (
    <Dialog
      open={Boolean(open && entry)}
      onClose={onCancel}
      dismissible={!busy}
      layer="stacked"
      size="sm"
      labelledBy="sftp-delete-confirm-title"
    >
      {entry ? (
        <>
          <DialogHeader
            icon={AlertTriangle}
            tone="danger"
            title={isDirectory ? t("Delete this remote folder?") : t("Delete this remote file?")}
            titleId="sftp-delete-confirm-title"
            description={t("Confirm Delete")}
          />
          <DialogBody className="space-y-3">
            <p className="text-[13px] leading-6 text-muted">
              <span className="font-medium text-text">{fileLabel}</span>{" "}
              {isDirectory
                ? t("and everything inside it will be removed from the remote server immediately.")
                : t("will be removed from the remote server immediately.")}
            </p>
            <div className="rounded-md border border-border bg-panel px-3 py-2">
              <div className="text-[11px] font-medium text-subtle">{t("Path")}</div>
              <div className="mt-0.5 font-mono text-xs break-all text-text">{entry.path}</div>
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
              {busy ? t("Deleting...") : t("Delete")}
            </Button>
          </DialogFooter>
        </>
      ) : null}
    </Dialog>
  );
}
