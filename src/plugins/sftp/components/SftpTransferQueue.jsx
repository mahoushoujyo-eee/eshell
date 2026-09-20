import {
  ArrowDownToLine,
  ArrowUpToLine,
  CheckCircle2,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useI18n } from "../../../lib/i18n";
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
    return <ArrowUpToLine className="h-3.5 w-3.5 text-accent" aria-hidden="true" />;
  }
  return <ArrowDownToLine className="h-3.5 w-3.5 text-accent" aria-hidden="true" />;
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
    <section className="absolute right-2 top-[3rem] z-20 w-[360px] max-w-[calc(100%-1rem)] rounded-lg border border-border bg-panel/95 p-2 shadow-xl backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
          <ArrowDownToLine className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          {t("Transfer Queue")}
        </div>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-0.5 text-[10px] transition-colors hover:bg-accent-soft"
          onClick={onClose}
        >
          {t("Close")}
        </button>
      </div>

      <div className="mb-2 rounded-md border border-border/70 bg-surface/50 px-2 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-[10px] text-muted">
            {t("Download Dir: {path}", { path: downloadDirectory || t("(not set)") })}
          </div>
          <button
            type="button"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-accent-soft"
            onClick={onConfigureDownloadDirectory}
          >
            {t("Change")}
          </button>
        </div>
      </div>

      <div className="max-h-72 overflow-auto pr-0.5">
        {transferRows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/70 bg-surface/40 px-2 py-2 text-[11px] text-muted">
            {t("No transfer tasks yet.")}
          </div>
        ) : (
          transferRows.map((transfer) => (
            <div
              key={transfer.transferId}
              className="mb-1.5 rounded-md border border-border/70 bg-panel/80 px-2 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {renderTransferIcon(transfer)}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{transfer.fileName}</div>
                    <div className="truncate text-[10px] text-muted">
                      {t(transferDirectionLabel(transfer.direction))}: {transfer.remotePath}
                    </div>
                  </div>
                </div>
                <span className={`text-[10px] font-medium ${transferStageColor(transfer.stage)}`}>
                  {t(transferStageLabel(transfer.stage))}
                </span>
              </div>

              {["queued", "started", "progress"].includes(transfer.stage) ? (
                <div className="mt-1 flex justify-end">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-accent-soft"
                    onClick={() => cancelTransfer?.(transfer.transferId)}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    {t("Cancel")}
                  </button>
                </div>
              ) : null}

              <div className="mt-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div
                    className={`h-full transition-all ${
                      transfer.stage === "failed" ? "bg-danger" : "bg-accent"
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, transfer.percent || 0))}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
                  <span>
                    {formatBytes(transfer.transferredBytes || 0)}
                    {transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
                  </span>
                  <span>{Math.round(transfer.percent || 0)}%</span>
                </div>
                {transfer.localPath ? (
                  <div className="mt-1 truncate text-[10px] text-muted">
                    {t("Local: {path}", { path: transfer.localPath })}
                  </div>
                ) : null}
                {transfer.message ? (
                  <div className="mt-1 truncate text-[10px] text-danger">{t(transfer.message)}</div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
