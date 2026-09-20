import { ArrowDown, ArrowUp, Network } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export function formatRate(value, formatBytes) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(numeric)}/s`;
}

export default function StatusTrafficPanel({
  currentStatus,
  currentNic,
  onNicChange,
  trafficRate,
  trafficSeries,
  trafficScaleMax,
  formatBytes,
}) {
  const { t } = useI18n();

  return (
    <div className="border-b border-border bg-surface/30 px-2 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <Network className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
          {t("Network")}
        </span>
        <select
          className="border border-border bg-panel px-1 py-0.5"
          value={currentNic || ""}
          onChange={(event) => onNicChange(event.target.value || null)}
        >
          {(currentStatus.networkInterfaces || []).map((networkInterface) => (
            <option key={networkInterface.interface} value={networkInterface.interface}>
              {networkInterface.interface}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-4 text-[11px] font-semibold">
        <span className="inline-flex items-center gap-1 text-[#e06f42]">
          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          {formatRate(trafficRate.tx, formatBytes)}
        </span>
        <span className="inline-flex items-center gap-1 text-[#2f8d4e]">
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          {formatRate(trafficRate.rx, formatBytes)}
        </span>
      </div>

      <div className="mt-1 h-14 border border-border/70 bg-panel/70 p-1">
        <div
          className="relative h-full w-full"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to right, transparent 0 12px, rgba(120,120,120,0.10) 12px 13px)",
          }}
        >
          <div className="absolute inset-0 flex items-end gap-px">
            {trafficSeries.map((point, index) => {
              const txHeight = Math.max(0, Math.round((point.tx / trafficScaleMax) * 100));
              const rxHeight = Math.max(0, Math.round((point.rx / trafficScaleMax) * 100));
              return (
                <div key={`traffic-${index}`} className="relative h-full min-w-0 flex-1">
                  {txHeight > 0 && (
                    <span
                      className="absolute bottom-0 left-[15%] w-[36%] bg-[#e7a57f]/90"
                      style={{ height: `${txHeight}%` }}
                    />
                  )}
                  {rxHeight > 0 && (
                    <span
                      className="absolute bottom-0 right-[15%] w-[36%] bg-[#84c68b]/90"
                      style={{ height: `${rxHeight}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {currentStatus.selectedInterfaceTraffic ? (
        <div className="mt-1 text-[10px] text-muted">
          {t("Total RX {rx} / Total TX {tx}", {
            rx: formatBytes(currentStatus.selectedInterfaceTraffic.rxBytes),
            tx: formatBytes(currentStatus.selectedInterfaceTraffic.txBytes),
          })}
        </div>
      ) : null}
    </div>
  );
}
