import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileText,
  FolderOpen,
  Image,
  LoaderCircle,
  Moon,
  Server,
  Settings2,
  Sun,
} from "lucide-react";

function RailButton({
  icon: Icon,
  label,
  onClick,
  collapsed = false,
  active = false,
  trailing = null,
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        className={[
          "relative inline-flex h-11 w-full items-center justify-center rounded-2xl border transition-all",
          active
            ? "border-accent/55 bg-accent-soft text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
            : "border-border/75 bg-panel/90 text-muted hover:border-accent/40 hover:bg-accent-soft hover:text-text",
        ].join(" ")}
        onClick={onClick}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        {typeof trailing === "function" ? trailing(true, active) : null}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={[
        "inline-flex w-full items-center rounded-xl border px-3 py-2 text-sm transition-colors",
        active
          ? "border-accent bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]"
          : "border-border/75 bg-panel text-muted hover:border-accent/40 hover:bg-accent-soft hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      {typeof trailing === "function" ? trailing(false, active) : trailing}
    </button>
  );
}

function StatusIndicator({ collapsed, icon: Icon, label, tone = "muted", spin = false, title }) {
  const toneClass = {
    muted: "text-muted",
    accent: "text-accent",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone];

  if (collapsed) {
    return (
      <div
        className={["inline-flex h-9 w-full items-center justify-center rounded-xl", toneClass].join(" ")}
        title={title || label}
        aria-label={label}
      >
        <Icon className={["h-4 w-4", spin ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={["inline-flex w-full items-center gap-1.5", toneClass].join(" ")} title={title || label}>
      <Icon className={["h-3.5 w-3.5 shrink-0", spin ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function ToolbarSection({ title, collapsed, children }) {
  return (
    <div className={["rounded-2xl border border-border/70 bg-panel/70", collapsed ? "p-1.5" : "p-2"].join(" ")}>
      {!collapsed ? (
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">{title}</div>
      ) : null}
      <div className={collapsed ? "space-y-1.5" : "space-y-1"}>{children}</div>
    </div>
  );
}

function ToggleSidebarButton({ collapsed, onClick }) {
  return (
    <button
      type="button"
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/75 bg-panel/92 text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text"
      onClick={onClick}
    >
      {collapsed ? (
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      ) : (
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}

function PanelVisibilityMarker(collapsed, active) {
  if (collapsed) {
    return (
      <span
        className={[
          "absolute right-2 bottom-2 h-2.5 w-2.5 rounded-full border border-panel",
          active ? "bg-success" : "bg-border",
        ].join(" ")}
      />
    );
  }

  return active ? (
    <CircleCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
  ) : (
    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-border" aria-hidden="true" />
  );
}

export default function TopToolbar({
  theme,
  wallpaperLabel,
  showSftpPanel,
  showStatusPanel,
  collapsed = false,
  onToggleCollapsed,
  onOpenSshConfig,
  onOpenScriptConfig,
  onToggleSftpPanel,
  onToggleStatusPanel,
  onOpenWallpaperPicker,
  onToggleTheme,
  busy,
  error,
}) {
  const hasError = Boolean(error && String(error).trim());
  const isWarning = hasError && /^warning/i.test(String(error).trim());
  const busyText = busy ? `Running: ${busy}` : "Idle";
  const errorDetail = hasError ? String(error).trim() : "";
  const errorText = hasError ? (isWarning ? "Background warning" : "Recent issue") : "No issues";
  const errorTitle = hasError ? errorDetail : errorText;

  return (
    <aside
      className={[
        "flex h-full shrink-0 flex-col border-r border-border bg-surface/95 py-2 transition-[width,padding] duration-300 ease-out",
        collapsed ? "w-[78px] px-1.5" : "w-[248px] px-2",
      ].join(" ")}
    >
      <div
        className={[
          "rounded-[22px] border border-border/75 bg-panel/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]",
          collapsed ? "px-2 py-2" : "px-3 py-3",
        ].join(" ")}
      >
        <div className={collapsed ? "flex flex-col items-center gap-2" : "flex items-start justify-between gap-3"}>
          <div
            className={
              collapsed
                ? "inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/75 bg-surface/85 text-accent"
                : ""
            }
          >
            <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-muted uppercase">
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              {!collapsed ? "eShell" : null}
            </div>
          </div>
          <ToggleSidebarButton collapsed={collapsed} onClick={onToggleCollapsed} />
        </div>
        {!collapsed ? <div className="mt-2 text-base font-semibold">Operations Console</div> : null}
      </div>

      <div className="mt-2 space-y-2">
        <ToolbarSection title="Config" collapsed={collapsed}>
          <RailButton icon={Server} label="SSH Profiles" onClick={onOpenSshConfig} collapsed={collapsed} />
          <RailButton icon={FileText} label="Script Center" onClick={onOpenScriptConfig} collapsed={collapsed} />
        </ToolbarSection>

        <ToolbarSection title="Panels" collapsed={collapsed}>
          <RailButton
            icon={FolderOpen}
            label={showSftpPanel ? "Hide SFTP panel" : "Show SFTP panel"}
            active={showSftpPanel}
            onClick={onToggleSftpPanel}
            collapsed={collapsed}
            trailing={PanelVisibilityMarker}
          />
          <RailButton
            icon={Activity}
            label={showStatusPanel ? "Hide status panel" : "Show status panel"}
            active={showStatusPanel}
            onClick={onToggleStatusPanel}
            collapsed={collapsed}
            trailing={PanelVisibilityMarker}
          />
        </ToolbarSection>
      </div>

      <div className="mt-auto pt-2">
        <ToolbarSection title="Quick" collapsed={collapsed}>
          <RailButton
            icon={Image}
            label={wallpaperLabel ? `Wallpaper: ${wallpaperLabel}` : "Wallpaper"}
            onClick={onOpenWallpaperPicker}
            collapsed={collapsed}
          />
          <RailButton
            icon={theme === "light" ? Moon : Sun}
            label={theme === "light" ? "Dark Mode" : "Light Mode"}
            onClick={onToggleTheme}
            collapsed={collapsed}
          />

          <div
            className={[
              "rounded-2xl border border-border/75 bg-surface/90 text-xs",
              collapsed ? "px-1 py-1" : "mt-2 px-3 py-2",
            ].join(" ")}
          >
            <div className={collapsed ? "space-y-0.5" : ""}>
              <StatusIndicator
                collapsed={collapsed}
                icon={LoaderCircle}
                label={busyText}
                title={busyText}
                tone={busy ? "accent" : "muted"}
                spin={busy}
              />
              <StatusIndicator
                collapsed={collapsed}
                icon={hasError ? AlertTriangle : CircleCheck}
                label={errorText}
                title={errorTitle}
                tone={hasError ? (isWarning ? "warning" : "danger") : "success"}
              />
            </div>
          </div>
        </ToolbarSection>
      </div>
    </aside>
  );
}
