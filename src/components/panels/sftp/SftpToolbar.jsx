import {
  ArrowUpToLine,
  Download,
  FilePlus2,
  FolderCog,
  FolderPlus,
  FolderOpen,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export default function SftpToolbar({
  activeSessionId,
  currentPath,
  refreshSftp,
  configureDownloadDirectory,
  downloadDirectory,
  uploadFile,
  createSftpEntry,
  downloadFile,
  selectedEntry,
  showTransferPanel,
  onToggleTransferPanel,
  activeTransferCount,
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center justify-between border-b border-border px-2 py-2">
      <div className="inline-flex items-center gap-2 text-sm font-semibold">
        <FolderOpen className="h-4 w-4 text-accent" aria-hidden="true" />
        {t("SFTP Browser")}
      </div>

      <div className="flex gap-1 text-xs">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
          onClick={() => refreshSftp(currentPath)}
          disabled={!activeSessionId}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Refresh")}
        </button>

        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
          onClick={configureDownloadDirectory}
          disabled={!activeSessionId}
          title={downloadDirectory || t("Set local download folder")}
        >
          <FolderCog className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Path")}
        </button>

        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
          onClick={() => createSftpEntry?.("file")}
          disabled={!activeSessionId}
          title={t("New file")}
        >
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t("File")}
        </button>

        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
          onClick={() => createSftpEntry?.("directory")}
          disabled={!activeSessionId}
          title={t("New folder")}
        >
          <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Folder")}
        </button>

        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Upload")}
          <input type="file" className="hidden" onChange={uploadFile} disabled={!activeSessionId} />
        </label>

        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
          onClick={downloadFile}
          disabled={!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory"}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Download")}
        </button>

        <button
          type="button"
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors",
            showTransferPanel ? "bg-accent-soft" : "hover:bg-accent-soft",
          ].join(" ")}
          onClick={onToggleTransferPanel}
          title={t("Toggle transfer queue")}
        >
          <ArrowUpToLine className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Transfers")}
          {activeTransferCount > 0 ? (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {activeTransferCount}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
