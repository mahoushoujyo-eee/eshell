import { Cpu, MemoryStick } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

const usageTone = (percent, base) => (percent >= 90 ? "bg-danger" : percent >= 75 ? "bg-warning" : base);

function ResourceRow({ icon: Icon, label, value, percent, tone }) {
  const width = Math.min(Math.max(Number(percent) || 0, 0), 100);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-muted">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </span>
        <span className="font-medium text-text tabular-nums">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-warm">
        <div className={["h-full rounded-full transition-[width] duration-300", usageTone(width, tone)].join(" ")} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export default function StatusResourceBars({ currentStatus, formatMemoryGb }) {
  const { t } = useI18n();

  return (
    <div className="grid shrink-0 grid-cols-1 gap-3 border-b border-border px-3 py-2.5">
      <ResourceRow
        icon={Cpu}
        label={t("CPU")}
        value={`${currentStatus.cpuPercent.toFixed(2)}%`}
        percent={currentStatus.cpuPercent}
        tone="bg-accent"
      />
      <ResourceRow
        icon={MemoryStick}
        label={t("Memory (GB)")}
        value={`${formatMemoryGb(currentStatus.memory.usedMb)} / ${formatMemoryGb(currentStatus.memory.totalMb)} GB`}
        percent={currentStatus.memory.usedPercent}
        tone="bg-info"
      />
    </div>
  );
}
