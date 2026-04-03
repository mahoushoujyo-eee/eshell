import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Clock3, HardDrive, List } from "lucide-react";
import StatusListSection from "./status/StatusListSection";
import StatusResourceBars from "./status/StatusResourceBars";
import StatusTrafficPanel from "./status/StatusTrafficPanel";
import { formatRate } from "./status/StatusTrafficPanel";

const MAX_TRAFFIC_POINTS = 48;

const emptyTrafficRate = Object.freeze({
  rx: 0,
  tx: 0,
});

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
          <StatusResourceBars currentStatus={currentStatus} formatMemoryGb={formatMemoryGb} />
          <StatusTrafficPanel
            currentStatus={currentStatus}
            currentNic={currentNic}
            onNicChange={onNicChange}
            trafficRate={trafficRate}
            trafficSeries={trafficSeries}
            trafficScaleMax={trafficScaleMax}
            formatBytes={formatBytes}
          />

          <div className="flex min-h-0 flex-1 flex-col">
            <StatusListSection
              title="Processes"
              icon={List}
              rows={currentStatus.topProcesses || []}
              getKey={(proc) => `${proc.pid}-${proc.command}`}
              className="border-b border-border bg-surface/20"
              renderRow={(proc) => (
                <div className="grid grid-cols-[40px_45px_45px_1fr] gap-1 border-b border-border/50 py-0.5">
                  <span>{proc.pid}</span>
                  <span>{proc.cpuPercent}%</span>
                  <span>{proc.memoryPercent}%</span>
                  <span className="truncate">{proc.command}</span>
                </div>
              )}
            />
            <StatusListSection
              title="Disks"
              icon={HardDrive}
              rows={currentStatus.disks || []}
              getKey={(disk) => `${disk.filesystem}-${disk.mountPoint}`}
              className="bg-surface/10"
              renderRow={(disk) => (
                <div className="grid grid-cols-[1fr_90px] gap-2 border-b border-border/50 py-0.5">
                  <span className="truncate">{disk.mountPoint}</span>
                  <span className="text-right">
                    {disk.used}/{disk.total}
                  </span>
                </div>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
