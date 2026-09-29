import { CircleAlert, CircleCheck, CircleSlash, Loader2, Trash2, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { IconButton } from "../../../components/ui/Button";

/** Status dot + label. Colour is the only thing that changes between states. */
const STATUS_STYLES = {
  active: { icon: CircleCheck, className: "text-success", label: "Active" },
  starting: { icon: Loader2, className: "text-muted animate-spin", label: "Starting..." },
  failed: { icon: CircleAlert, className: "text-danger", label: "Failed" },
  stopped: { icon: CircleSlash, className: "text-subtle", label: "Stopped" },
};

const formatBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
};

export default function ForwardRow({ forward, stopping, onStop, onForget }) {
  const { t } = useI18n();
  const status = STATUS_STYLES[forward.status] || STATUS_STYLES.stopped;
  const StatusIcon = status.icon;
  const running = forward.status === "active" || forward.status === "starting";
  const route = `${forward.bindHost}:${forward.bindPort} → ${forward.targetHost}:${forward.targetPort}`;

  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-hover">
      <StatusIcon
        className={`h-3.5 w-3.5 shrink-0 ${status.className}`}
        aria-hidden="true"
      />

      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text/90" title={route}>
        <span className="text-muted">{forward.bindHost}:</span>
        <span className="font-semibold text-text">{forward.bindPort}</span>
        <span className="mx-1 text-subtle">→</span>
        <span>
          {forward.targetHost}:{forward.targetPort}
        </span>
      </span>

      {forward.status === "active" ? (
        <span className="shrink-0 text-[11px] text-muted tabular-nums">
          {forward.activeConnections > 0 ? `${forward.activeConnections} · ` : ""}↑
          {formatBytes(forward.bytesUp)} ↓{formatBytes(forward.bytesDown)}
        </span>
      ) : null}

      {forward.error ? (
        <span className="max-w-40 shrink-0 truncate text-[11px] text-danger" title={forward.error}>
          {forward.error}
        </span>
      ) : null}

      {running ? (
        <IconButton
          label={t("Stop forward")}
          size="xs"
          onClick={() => onStop?.(forward.id)}
          disabled={stopping}
        >
          {stopping ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </IconButton>
      ) : (
        <IconButton
          label={t("Remove")}
          size="xs"
          tone="danger"
          onClick={() => onForget?.(forward.id)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
