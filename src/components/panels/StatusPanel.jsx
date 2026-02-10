export default function StatusPanel({ currentStatus, currentNic, onNicChange, formatBytes }) {
  return (
    <div className="h-full overflow-auto rounded-xl border border-border/90 bg-panel p-2 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">服务器状态</div>
        {currentStatus?.fetchedAt && (
          <span className="text-muted">{new Date(currentStatus.fetchedAt).toLocaleTimeString()}</span>
        )}
      </div>
      {currentStatus && (
        <>
          <div className="mb-2 rounded border border-border/80 bg-surface p-2">
            <div className="mb-1 flex justify-between">
              <span>CPU</span>
              <span>{currentStatus.cpuPercent.toFixed(2)}%</span>
            </div>
            <div className="h-2 rounded bg-warm">
              <div
                className="h-full rounded bg-accent"
                style={{ width: `${Math.min(currentStatus.cpuPercent, 100)}%` }}
              />
            </div>
            <div className="mt-2 mb-1 flex justify-between">
              <span>内存</span>
              <span>
                {currentStatus.memory.usedMb.toFixed(1)} / {currentStatus.memory.totalMb.toFixed(1)} MB
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
              <span>网卡</span>
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
            <div className="mb-1 font-medium">进程</div>
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
            <div className="mb-1 font-medium">磁盘</div>
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
