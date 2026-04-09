import { Cpu, Server } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export default function StatusResourceBars({ currentStatus, formatMemoryGb }) {
  const { t } = useI18n();

  return (
    <div className="border-b border-border bg-surface/40 px-2 py-2">
      <div className="mb-1 flex justify-between">
        <span className="inline-flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          {t("CPU")}
        </span>
        <span>{currentStatus.cpuPercent.toFixed(2)}%</span>
      </div>
      <div className="h-2 bg-warm">
        <div
          className="h-full bg-accent"
          style={{ width: `${Math.min(currentStatus.cpuPercent, 100)}%` }}
        />
      </div>

      <div className="mt-2 mb-1 flex justify-between">
        <span className="inline-flex items-center gap-1.5">
          <Server className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          {t("Memory (GB)")}
        </span>
        <span>
          {formatMemoryGb(currentStatus.memory.usedMb)} / {formatMemoryGb(currentStatus.memory.totalMb)} GB
        </span>
      </div>
      <div className="h-2 bg-warm">
        <div
          className="h-full bg-success"
          style={{ width: `${Math.min(currentStatus.memory.usedPercent, 100)}%` }}
        />
      </div>
    </div>
  );
}
