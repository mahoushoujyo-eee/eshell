import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Clock3, Gpu, HardDrive, List } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import PanelHeader from "../../components/ui/PanelHeader";
import SegmentedControl from "../../components/ui/SegmentedControl";
import StatusResourceBars from "./components/StatusResourceBars";
import StatusTrafficPanel from "./components/StatusTrafficPanel";

const MAX_TRAFFIC_POINTS = 48;

const emptyTrafficRate = Object.freeze({
  rx: 0,
  tx: 0,
});

const DETAIL_VIEW = Object.freeze({
  processes: "processes",
  disks: "disks",
  gpus: "gpus",
});

const parsePercent = (value) => {
  const numeric = Number.parseFloat(String(value || "").replace("%", "").trim());
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(100, Math.max(0, numeric));
};

const PROCESS_GRID = "grid grid-cols-[64px_60px_92px_minmax(0,1fr)] gap-2";

function ProcessesView({ rows = [] }) {
  const { t } = useI18n();

  if (!rows.length) {
    return <div className="px-3 py-4 text-xs text-muted">{t("No process data")}</div>;
  }

  return (
    <div className="scroll-region min-h-0 flex-1 overflow-auto">
      <div
        className={`${PROCESS_GRID} sticky top-0 z-10 h-6 items-center border-b border-border bg-panel px-3 text-[11px] font-medium text-subtle`}
      >
        <span>PID</span>
        <span>{t("CPU")}</span>
        <span>{t("Memory (MB)")}</span>
        <span>{t("Command")}</span>
      </div>

      <div className="px-1 py-1">
        {rows.map((proc) => (
          <div
            key={`${proc.pid}-${proc.command}`}
            className={`${PROCESS_GRID} h-7 items-center rounded-md px-2 text-xs transition-colors hover:bg-hover`}
          >
            <span className="font-mono text-[11px] text-muted tabular-nums">{proc.pid}</span>
            <span className="text-text tabular-nums">{proc.cpuPercent}%</span>
            <span className="text-muted tabular-nums">
              {Number.isFinite(Number(proc.memoryMb)) ? `${Number(proc.memoryMb).toFixed(1)} MB` : "-"}
            </span>
            <span className="truncate text-text" title={proc.command}>
              {proc.command}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const usageTone = (percent) => (percent >= 90 ? "bg-danger" : percent >= 75 ? "bg-warning" : "bg-accent");

function DisksView({ rows = [] }) {
  const { t } = useI18n();

  if (!rows.length) {
    return <div className="px-3 py-4 text-xs text-muted">{t("No disk data")}</div>;
  }

  return (
    <div className="scroll-region min-h-0 flex-1 overflow-auto px-1 py-1">
      {rows.map((disk) => {
        const usedPercent = parsePercent(disk.usedPercent);

        return (
          <div
            key={`${disk.filesystem}-${disk.mountPoint}`}
            className="rounded-md px-2 py-2 transition-colors hover:bg-hover"
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-mono text-xs font-medium text-text">{disk.mountPoint}</span>
                <span className="truncate text-[11px] text-subtle">{disk.filesystem}</span>
              </div>
              <div className="shrink-0 text-xs text-muted tabular-nums">
                <span className="text-text">
                  {disk.used}/{disk.total}
                </span>{" "}
                · {disk.usedPercent} {t("used")}
              </div>
            </div>

            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-warm">
              <div
                className={["h-full rounded-full", usageTone(usedPercent)].join(" ")}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MetricBar({ label, value, percent, tone = "bg-accent" }) {
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted">{label}</span>
        <span className="text-[11px] font-medium text-text tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-warm">
        {safePercent === null ? null : (
          <div className={["h-full rounded-full", tone].join(" ")} style={{ width: `${safePercent}%` }} />
        )}
      </div>
    </div>
  );
}

function GpusView({ rows = [], formatMemoryGb }) {
  const { t } = useI18n();

  if (!rows.length) {
    return (
      <div className="px-3 py-4 text-xs text-muted">
        {t("No NVIDIA GPU detected on this host.")}
      </div>
    );
  }

  const formatNumber = (value, unit, digits = 0) =>
    Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${unit}` : "-";

  return (
    <div className="scroll-region min-h-0 flex-1 overflow-auto px-2 py-2">
      <div className="space-y-2">
        {rows.map((gpu) => {
          const usedMb = Number(gpu.memoryUsedMb);
          const totalMb = Number(gpu.memoryTotalMb);
          const memoryPercent =
            Number.isFinite(usedMb) && Number.isFinite(totalMb) && totalMb > 0
              ? (usedMb / totalMb) * 100
              : null;
          const memoryTone =
            memoryPercent === null
              ? "bg-accent"
              : memoryPercent >= 90
                ? "bg-danger"
                : memoryPercent >= 75
                  ? "bg-warning"
                  : "bg-accent";

          const utilization = Number(gpu.utilizationPercent);
          const drawW = Number(gpu.powerDrawW);
          const limitW = Number(gpu.powerLimitW);
          const powerPercent =
            Number.isFinite(drawW) && Number.isFinite(limitW) && limitW > 0
              ? (drawW / limitW) * 100
              : null;

          const processes = Array.isArray(gpu.processes) ? gpu.processes : [];

          return (
            <div key={gpu.index} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold" title={gpu.name}>
                    {gpu.name}
                  </div>
                  <div className="text-[11px] text-muted">
                    GPU {gpu.index}
                    {Number.isFinite(Number(gpu.temperatureC))
                      ? ` · ${formatNumber(gpu.temperatureC, "°C")}`
                      : ""}
                    {Number.isFinite(Number(gpu.fanPercent))
                      ? ` · ${t("Fan")} ${formatNumber(gpu.fanPercent, "%")}`
                      : ""}
                  </div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <MetricBar
                  label={t("GPU load")}
                  value={formatNumber(utilization, "%")}
                  percent={utilization}
                />
                <MetricBar
                  label={t("VRAM")}
                  value={
                    Number.isFinite(usedMb) && Number.isFinite(totalMb)
                      ? `${formatMemoryGb(usedMb)} / ${formatMemoryGb(totalMb)} GB`
                      : "-"
                  }
                  percent={memoryPercent}
                  tone={memoryTone}
                />
                <MetricBar
                  label={t("Power")}
                  value={
                    Number.isFinite(drawW)
                      ? Number.isFinite(limitW)
                        ? `${drawW.toFixed(0)} / ${limitW.toFixed(0)} W`
                        : `${drawW.toFixed(0)} W`
                      : "-"
                  }
                  percent={powerPercent}
                />
              </div>

              <div className="mt-2 border-t border-border pt-2">
                {processes.length ? (
                  <div className="space-y-1">
                    {processes.map((proc) => (
                      <div
                        key={`${gpu.index}-${proc.pid}-${proc.command}`}
                        className="grid grid-cols-[64px_84px_minmax(0,1fr)] items-baseline gap-2 text-[11px]"
                      >
                        <span className="font-mono text-muted tabular-nums">{proc.pid}</span>
                        <span className="tabular-nums text-muted">
                          {Number.isFinite(Number(proc.memoryMb))
                            ? `${Number(proc.memoryMb).toFixed(0)} MB`
                            : "-"}
                        </span>
                        <span className="truncate text-text" title={proc.command}>
                          {proc.command}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted">{t("No process is using this GPU")}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const INTERVAL_OPTIONS = [
  { label: "3s", value: 3000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

export default function StatusPanel({
  activeSessionId,
  currentStatus,
  currentNic,
  onNicChange,
  formatBytes,
  refreshInterval = 5000,
  onRefreshIntervalChange,
}) {
  const { localeTag, t } = useI18n();
  const [trafficRate, setTrafficRate] = useState(emptyTrafficRate);
  const [trafficSeries, setTrafficSeries] = useState([]);
  const [detailView, setDetailView] = useState(DETAIL_VIEW.processes);
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

  useEffect(() => {
    const hasProcesses = Boolean(currentStatus?.topProcesses?.length);
    const hasDisks = Boolean(currentStatus?.disks?.length);

    if (detailView === DETAIL_VIEW.processes && !hasProcesses && hasDisks) {
      setDetailView(DETAIL_VIEW.disks);
    } else if (detailView === DETAIL_VIEW.disks && !hasDisks && hasProcesses) {
      setDetailView(DETAIL_VIEW.processes);
    }
  }, [currentStatus?.disks?.length, currentStatus?.topProcesses?.length, detailView]);

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-panel text-xs">
      <PanelHeader
        icon={Activity}
        title={t("Server Status")}
        actions={
          <div className="flex items-center gap-2">
            {currentStatus?.fetchedAt && (
              <span className="hidden items-center gap-1 text-[11px] text-muted tabular-nums @xs:inline-flex">
                <Clock3 className="h-3 w-3" aria-hidden="true" />
                {new Date(currentStatus.fetchedAt).toLocaleTimeString(localeTag)}
              </span>
            )}
            <SegmentedControl
              size="2xs"
              value={refreshInterval}
              onChange={(value) => {
                onRefreshIntervalChange?.(value);
                window.localStorage?.setItem("eshell:status-refresh-interval", String(value));
              }}
              options={INTERVAL_OPTIONS.map((opt) => ({
                id: opt.value,
                label: opt.label,
                title: t("Refresh every {interval}", { interval: opt.label }),
              }))}
            />
          </div>
        }
      />

      {!currentStatus && (
        <div className="flex flex-1 items-center justify-center text-muted">{t("No status data")}</div>
      )}

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
            <div className="tab-strip flex h-9 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-border px-3">
              <div className="hidden shrink-0 text-[11px] font-semibold tracking-[0.08em] whitespace-nowrap text-subtle uppercase @sm:block">
                {t("Detail Focus")}
              </div>

              <SegmentedControl
                size="xs"
                value={detailView}
                onChange={setDetailView}
                options={[
                  {
                    id: DETAIL_VIEW.processes,
                    label: t("Processes"),
                    icon: List,
                    trailing: currentStatus.topProcesses?.length || 0,
                  },
                  {
                    id: DETAIL_VIEW.disks,
                    label: t("Disks"),
                    icon: HardDrive,
                    trailing: currentStatus.disks?.length || 0,
                  },
                  {
                    id: DETAIL_VIEW.gpus,
                    label: t("GPU"),
                    icon: Gpu,
                    trailing: currentStatus.gpus?.length || 0,
                  },
                ]}
              />
            </div>

            {detailView === DETAIL_VIEW.disks ? (
              <DisksView rows={currentStatus.disks || []} />
            ) : detailView === DETAIL_VIEW.gpus ? (
              <GpusView rows={currentStatus.gpus || []} formatMemoryGb={formatMemoryGb} />
            ) : (
              <ProcessesView rows={currentStatus.topProcesses || []} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
