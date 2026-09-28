import {
  ArrowDownToLine,
  ArrowUpToLine,
  CheckCircle2,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button, { IconButton } from "../../../components/ui/Button";
import {
  transferDirectionLabel,
  transferStageColor,
  transferStageLabel,
} from "./sftpPanelUtils";

const renderTransferIcon = (transfer) => {
  if (transfer.stage === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />;
  }
  if (transfer.stage === "cancelled") {
    return <X className="h-3.5 w-3.5 text-warning" aria-hidden="true" />;
  }
  if (transfer.stage === "failed") {
    return <TriangleAlert className="h-3.5 w-3.5 text-danger" aria-hidden="true" />;
  }
  if (transfer.stage === "queued") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" aria-hidden="true" />;
  }
  if (transfer.direction === "upload") {
    return <ArrowUpToLine className="h-3.5 w-3.5 text-info" aria-hidden="true" />;
  }
  return <ArrowDownToLine className="h-3.5 w-3.5 text-info" aria-hidden="true" />;
};

export default function SftpTransferQueue({
  open,
  transferRows,
  downloadDirectory,
  onConfigureDownloadDirectory,
  cancelTransfer,
  formatBytes,
  onClose,
}) {
  const { t } = useI18n();

  if (!open) {
    return null;
  }

  return (
    <section className="absolute top-9 right-2 z-20 flex max-h-[calc(100%-2.75rem)] w-[360px] max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-overlay animate-[es-dialog-in_140ms_ease-out]">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border pr-1.5 pl-3">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
          <ArrowDownToLine className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          {t("Transfer Queue")}
        </div>
        <IconButton label={t("Close")} size="xs" onClick={onClose}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0 truncate text-[11px] text-muted" title={downloadDirectory || ""}>
          {t("Download Dir: {path}", { path: downloadDirectory || t("(not set)") })}
        </div>
        <Button variant="ghost" size="xs" onClick={onConfigureDownloadDirectory}>
          {t("Change")}
        </Button>
      </div>

      <div className="scroll-region min-h-0 flex-1 overflow-auto p-1.5">
        {transferRows.length === 0 ? (
          <div className="px-2 py-4 text-center text-[11px] text-subtle">{t("No transfer tasks yet.")}</div>
        ) : (
          transferRows.map((transfer) => (
            <div key={transfer.transferId} className="rounded-md px-2 py-2 transition-colors hover:bg-hover">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {renderTransferIcon(transfer)}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{transfer.fileName}</div>
                    <div className="truncate font-mono text-[10.5px] text-muted">
                      {t(transferDirectionLabel(transfer.direction))}: {transfer.remotePath}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className={`text-[11px] font-medium ${transferStageColor(transfer.stage)}`}>
                    {t(transferStageLabel(transfer.stage))}
                  </span>
                  {["queued", "started", "progress"].includes(transfer.stage) ? (
                    <Button variant="ghost" size="xs" onClick={() => cancelTransfer?.(transfer.transferId)}>
                      <X className="h-3 w-3" aria-hidden="true" />
                      {t("Cancel")}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="mt-1.5 pl-5.5">
                <div className="h-1 overflow-hidden rounded-full bg-warm">
                  <div
                    className={`h-full rounded-full transition-all ${
                      transfer.stage === "failed" ? "bg-danger" : "bg-accent"
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, transfer.percent || 0))}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10.5px] text-muted tabular-nums">
                  <span>
                    {formatBytes(transfer.transferredBytes || 0)}
                    {transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
                  </span>
                  <span>{Math.round(transfer.percent || 0)}%</span>
                </div>
                {transfer.localPath ? (
                  <div className="mt-0.5 truncate text-[10.5px] text-subtle" title={transfer.localPath}>
                    {t("Local: {path}", { path: transfer.localPath })}
                  </div>
                ) : null}
                {transfer.message ? (
                  <div className="mt-0.5 truncate text-[10.5px] text-danger">{t(transfer.message)}</div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
