import { FolderDown, FolderOpen } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button from "../../../components/ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../../../components/ui/Dialog";

/**
 * Explains that folder download is not supported.
 *
 * The backend transfers one remote file into the local download directory;
 * there is no recursive folder transfer, so a folder request would fail deep
 * inside the transfer with an opaque IO error. The panel intercepts the
 * request and shows this dialog instead, and offers the nearest useful action:
 * opening the folder so its files can be picked one by one.
 */
export default function SftpFolderDownloadDialog({ open, entry, onClose, onOpenFolder }) {
  const { t } = useI18n();

  const folderLabel = entry?.name?.trim() || entry?.path || t("Selected folder");
  const folderPath = entry?.path || "";

  return (
    <Dialog
      open={Boolean(open && entry)}
      onClose={onClose}
      layer="stacked"
      size="sm"
      labelledBy="sftp-folder-download-title"
    >
      {entry ? (
        <>
          <DialogHeader
            icon={FolderDown}
            tone="warning"
            title={t("Folder download is not supported")}
            titleId="sftp-folder-download-title"
            description={t("Only single files can be downloaded")}
          />
          <DialogBody className="space-y-3">
            <p className="text-[13px] leading-6 text-muted">
              <span className="font-medium text-text">{folderLabel}</span>{" "}
              {t("is a folder. Open it and download the files inside one by one.")}
            </p>
            <div className="rounded-md border border-border bg-panel px-3 py-2">
              <div className="text-[11px] font-medium text-subtle">{t("Path")}</div>
              <div className="mt-0.5 font-mono text-xs break-all text-text">{folderPath}</div>
            </div>
          </DialogBody>
          <DialogFooter>
            {onOpenFolder ? (
              <Button variant="secondary" onClick={onOpenFolder}>
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Open Folder")}
              </Button>
            ) : null}
            <Button variant="primary" onClick={onClose}>
              {t("OK")}
            </Button>
          </DialogFooter>
        </>
      ) : null}
    </Dialog>
  );
}
