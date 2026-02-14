import { Activity, Clock3, Cpu, HardDrive, List, Network, Server } from "lucide-react";

export default function StatusPanel({ currentStatus, currentNic, onNicChange, formatBytes }) {
  const formatMemoryGb = (mb) => (Number(mb || 0) / 1024).toFixed(2);

  return (
    <div className="h-full overflow-auto rounded-xl border border-border/90 bg-panel p-2 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
          Server Status
        </div>
        {currentStatus?.fetchedAt && (
          <span className="inline-flex items-center gap-1 text-muted">
            <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
            {new Date(currentStatus.fetchedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {currentStatus && (
        <>
          <div className="mb-2 rounded border border-border/80 bg-surface p-2">
            <div className="mb-1 flex justify-between">
              <span className="inline-flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                CPU
              </span>
              <span>{currentStatus.cpuPercent.toFixed(2)}%</span>
            </div>
            <div className="h-2 rounded bg-warm">
              <div
                className="h-full rounded bg-accent"
                style={{ width: `${Math.min(currentStatus.cpuPercent, 100)}%` }}
              />
            </div>

            <div className="mt-2 mb-1 flex justify-between">
              <span className="inline-flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                Memory
              </span>
              <span>
                {formatMemoryGb(currentStatus.memory.usedMb)} / {formatMemoryGb(currentStatus.memory.totalMb)} GB
              </span>
            </div>
            <div className="h-2 rounded bg-warm">
              <div
                className="h-full rounded bg-success"
                style={{ width: `${Math.min(currentStatus.memory.usedPercent, 100)}%` }}
              />
            </div>
          </div>

          <div className="mb-2 rounded border border-border/80 bg-surface p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5">
                <Network className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                Network
              </span>
              <select
                className="rounded border border-border bg-panel px-1 py-0.5"
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
            {currentStatus.selectedInterfaceTraffic && (
              <div className="text-muted">
                RX {formatBytes(currentStatus.selectedInterfaceTraffic.rxBytes)} / TX{" "}
                {formatBytes(currentStatus.selectedInterfaceTraffic.txBytes)}
              </div>
            )}
          </div>

          <div className="mb-2 rounded border border-border/80 bg-surface p-2">
            <div className="mb-1 inline-flex items-center gap-1.5 font-medium">
              <List className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              Processes
            </div>
            <div className="max-h-20 overflow-auto">
              {(currentStatus.topProcesses || []).map((proc) => (
                <div
                  key={`${proc.pid}-${proc.command}`}
                  className="grid grid-cols-[40px_45px_45px_1fr] gap-1 border-b border-border/50 py-0.5"
                >
                  <span>{proc.pid}</span>
                  <span>{proc.cpuPercent}%</span>
                  <span>{proc.memoryPercent}%</span>
                  <span className="truncate">{proc.command}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded border border-border/80 bg-surface p-2">
            <div className="mb-1 inline-flex items-center gap-1.5 font-medium">
              <HardDrive className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              Disks
            </div>
            <div className="max-h-18 overflow-auto">
              {(currentStatus.disks || []).map((disk) => (
                <div
                  key={`${disk.filesystem}-${disk.mountPoint}`}
                  className="grid grid-cols-[1fr_90px] gap-2 border-b border-border/50 py-0.5"
                >
                  <span className="truncate">{disk.mountPoint}</span>
                  <span className="text-right">
                    {disk.used}/{disk.total}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
