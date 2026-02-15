import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Clock3,
  Cpu,
  HardDrive,
  List,
  Network,
  Server,
} from "lucide-react";

const MAX_TRAFFIC_POINTS = 48;

const emptyTrafficRate = Object.freeze({
  rx: 0,
  tx: 0,
});

function formatRate(value, formatBytes) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(numeric)}/s`;
}

export default function StatusPanel({
  activeSessionId,
  currentStatus,
  currentNic,
  onNicChange,
  formatBytes,
}) {
  const [trafficRate, setTrafficRate] = useState(emptyTrafficRate);
  const [trafficSeries, setTrafficSeries] = useState([]);
  const previousTrafficRef = useRef(null);

  const formatMemoryGb = (mb) => (Number(mb || 0) / 1024).toFixed(2);

  useEffect(() => {
    const selectedTraffic = currentStatus?.selectedInterfaceTraffic;
    const selectedName =
      currentStatus?.selectedInterface || selectedTraffic?.interface || "";

    if (!activeSessionId || !selectedTraffic || !selectedName) {
      previousTrafficRef.current = null;
      setTrafficRate(emptyTrafficRate);
      setTrafficSeries([]);
      return;
    }

    const snapshot = {
      sessionId: activeSessionId,
      interface: selectedName,
      rxBytes: Number(selectedTraffic.rxBytes || 0),
      txBytes: Number(selectedTraffic.txBytes || 0),
      fetchedAtMs: Date.parse(currentStatus?.fetchedAt || "") || Date.now(),
    };

    const previous = previousTrafficRef.current;
    const sameSource =
      previous &&
      previous.sessionId === snapshot.sessionId &&
      previous.interface === snapshot.interface;

    let nextRate = emptyTrafficRate;
    if (sameSource) {
      const seconds = (snapshot.fetchedAtMs - previous.fetchedAtMs) / 1000;
      if (seconds > 0) {
        nextRate = {
          rx: Math.max(0, (snapshot.rxBytes - previous.rxBytes) / seconds),
          tx: Math.max(0, (snapshot.txBytes - previous.txBytes) / seconds),
        };
      }
    }

    previousTrafficRef.current = snapshot;
    setTrafficRate(nextRate);
    setTrafficSeries((previousSeries) => {
      const base = sameSource ? previousSeries : [];
      const next = [...base, nextRate];
      return next.slice(-MAX_TRAFFIC_POINTS);
    });
  }, [
    activeSessionId,
    currentStatus?.selectedInterface,
    currentStatus?.selectedInterfaceTraffic?.interface,
    currentStatus?.selectedInterfaceTraffic?.rxBytes,
    currentStatus?.selectedInterfaceTraffic?.txBytes,
    currentStatus?.fetchedAt,
  ]);

  const trafficScaleMax = useMemo(() => {
    const peaks = trafficSeries.flatMap((item) => [item.rx, item.tx]);
    return Math.max(1, ...peaks, trafficRate.rx, trafficRate.tx);
  }, [trafficSeries, trafficRate]);

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

            {currentStatus.selectedInterfaceTraffic && (
              <div className="mt-1 text-[10px] text-muted">
                Total RX {formatBytes(currentStatus.selectedInterfaceTraffic.rxBytes)} / Total TX{" "}
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
