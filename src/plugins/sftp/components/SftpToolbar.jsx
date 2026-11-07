import { ArrowDownUp, Download, FolderOpen, Plus, RefreshCw, Upload } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { IconButton } from "../../../components/ui/Button";
import PanelHeader from "../../../components/ui/PanelHeader";

export default function SftpToolbar({
  activeSessionId,
  currentPath,
  refreshSftp,
  uploadFile,
  createSftpEntry,
  onDownload,
  selectedEntry,
  showTransferPanel,
  onToggleTransferPanel,
  activeTransferCount,
}) {
  const { t } = useI18n();

  return (
    <PanelHeader
      icon={FolderOpen}
      title={t("SFTP Browser")}
      actions={
        <>
          <IconButton
            label={t("Refresh")}
            size="xs"
            onClick={() => refreshSftp(currentPath)}
            disabled={!activeSessionId}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t("New")}
            size="xs"
            onClick={() => createSftpEntry?.("file")}
            disabled={!activeSessionId}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton label={t("Upload")} size="xs" onClick={uploadFile} disabled={!activeSessionId}>
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t("Download")}
            size="xs"
            // The handler is wrapped, not passed by reference: a bare
            // `onClick={downloadFile}` hands the click event to the download
            // operation, which then reads it as a remote entry and tries to
            // download the remote root ("/") instead of the selected file.
            onClick={() => onDownload?.()}
            // Folders stay clickable on purpose: the panel explains that
            // folder download is not supported instead of silently ignoring
            // the click.
            disabled={!activeSessionId || !selectedEntry}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <span className="mx-1 h-3.5 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            className={[
              "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors duration-150",
              showTransferPanel ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-text",
            ].join(" ")}
            onClick={onToggleTransferPanel}
            title={t("Toggle transfer queue")}
            aria-pressed={showTransferPanel}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Transfers")}
            {activeTransferCount > 0 ? (
              <span className="rounded bg-accent px-1 text-[10px] leading-4 font-semibold text-on-accent tabular-nums">
                {activeTransferCount}
              </span>
            ) : null}
          </button>
        </>
      }
    />
  );
}
