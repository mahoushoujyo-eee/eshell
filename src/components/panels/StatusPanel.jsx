import { Activity, Clock3, Cpu, HardDrive, List, Network, Server } from "lucide-react";

export default function StatusPanel({ currentStatus, currentNic, onNicChange, formatBytes }) {
  const formatMemoryGb = (mb) => (Number(mb || 0) / 1024).toFixed(2);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-xs">
      <div className="flex items-center justify-between border-b border-border px-2 py-2">
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

      {!currentStatus && <div className="flex flex-1 items-center justify-center text-muted">No status data</div>}

      {currentStatus && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border bg-surface/40 px-2 py-2">
            <div className="mb-1 flex justify-between">
              <span className="inline-flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                CPU
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
                Memory
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

          <div className="border-b border-border bg-surface/30 px-2 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5">
                <Network className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
                Network
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
            {currentStatus.selectedInterfaceTraffic && (
              <div className="text-muted">
                RX {formatBytes(currentStatus.selectedInterfaceTraffic.rxBytes)} / TX{" "}
                {formatBytes(currentStatus.selectedInterfaceTraffic.txBytes)}
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col border-b border-border bg-surface/20 px-2 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 font-medium">
                <List className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                Processes
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
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

            <div className="flex min-h-0 flex-1 flex-col bg-surface/10 px-2 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 font-medium">
                <HardDrive className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                Disks
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
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
          </div>
        </div>
      )}
    </div>
  );
}
