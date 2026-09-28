import { ArrowDown, ArrowUp, Network } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { selectSmClass } from "../../../components/ui/fieldClasses";

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
    <div className="shrink-0 border-b border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted">
          <Network className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Network")}
        </span>
        <select
          className={`${selectSmClass} h-6`}
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

      <div className="mb-1.5 flex items-center gap-3">
        <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap text-info tabular-nums">
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
          {formatRate(trafficRate.tx, formatBytes)}
        </span>
        <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap text-accent tabular-nums">
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
          {formatRate(trafficRate.rx, formatBytes)}
        </span>
      </div>

      <div className="relative h-12 overflow-hidden rounded-md border border-border bg-surface px-1 pt-1">
        <div className="absolute inset-0 flex items-end gap-px px-1 pt-1">
          {trafficSeries.map((point, index) => {
            const txHeight = Math.max(0, Math.round((point.tx / trafficScaleMax) * 100));
            const rxHeight = Math.max(0, Math.round((point.rx / trafficScaleMax) * 100));
            return (
              <div key={`traffic-${index}`} className="relative h-full min-w-0 flex-1">
                {txHeight > 0 && (
                  <span
                    className="absolute bottom-0 left-[12%] w-[36%] rounded-t-[1px] bg-info/75"
                    style={{ height: `${txHeight}%` }}
                  />
                )}
                {rxHeight > 0 && (
                  <span
                    className="absolute right-[12%] bottom-0 w-[36%] rounded-t-[1px] bg-accent/75"
                    style={{ height: `${rxHeight}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {currentStatus.selectedInterfaceTraffic ? (
        <div className="mt-1.5 text-[11px] text-subtle tabular-nums">
          {t("Total RX {rx} / Total TX {tx}", {
            rx: formatBytes(currentStatus.selectedInterfaceTraffic.rxBytes),
            tx: formatBytes(currentStatus.selectedInterfaceTraffic.txBytes),
          })}
        </div>
      ) : null}
    </div>
  );
}
