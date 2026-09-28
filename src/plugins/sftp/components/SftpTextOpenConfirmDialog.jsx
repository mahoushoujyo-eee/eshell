import { AlertTriangle, FileQuestion, Loader2 } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button from "../../../components/ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../../../components/ui/Dialog";

export default function SftpTextOpenConfirmDialog({
  open,
  entry,
  guard,
  busy = false,
  formatBytes,
  onCancel,
  onConfirm,
}) {
  const { t } = useI18n();
  const visible = Boolean(open && entry && guard);

  const fileLabel = entry?.name?.trim() || entry?.path || t("Selected file");
  const sizeLabel = visible
    ? typeof formatBytes === "function"
      ? formatBytes(guard.size || entry.size || 0)
      : `${guard.size || 0} B`
    : "";

  return (
    <Dialog
      open={visible}
      onClose={onCancel}
      dismissible={!busy}
      layer="stacked"
      size="md"
      labelledBy="sftp-open-confirm-title"
    >
      {visible ? (
        <>
          <DialogHeader
            icon={AlertTriangle}
            tone="warning"
            title={t("Open file as text?")}
            titleId="sftp-open-confirm-title"
            description={t("Text Editor Check")}
          />
          <DialogBody className="space-y-3">
            <p className="text-[13px] leading-6 text-muted">
              <span className="font-medium text-text">{fileLabel}</span>{" "}
              {t("may not be a good fit for the built-in text editor.")}
            </p>

            <div className="rounded-md border border-border bg-panel px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                <FileQuestion className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                {t("File details")}
              </div>
              <div className="mt-1.5 space-y-0.5 font-mono text-[11px] text-muted">
                <div className="break-all">{t("Path: {path}", { path: entry.path })}</div>
                <div>{t("Size: {size}", { size: sizeLabel })}</div>
              </div>
            </div>

            {guard.isLarge || guard.isBinaryLike ? (
              <div className="space-y-1.5 text-[13px] leading-6 text-muted">
                {guard.isLarge ? (
                  <p>{t("This file is larger than 50 MB and may be slow to load in the text editor.")}</p>
                ) : null}
                {guard.isBinaryLike ? (
                  <p>
                    {guard.extension
                      ? t(".{extension} is a common binary format, so the content may be unreadable as text.", {
                          extension: guard.extension,
                        })
                      : t(
                          "This file looks like a common binary format, so the content may be unreadable as text.",
                        )}
                  </p>
                ) : null}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FileQuestion className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {busy ? t("Opening...") : t("Open Anyway")}
            </Button>
          </DialogFooter>
        </>
      ) : null}
    </Dialog>
  );
}
