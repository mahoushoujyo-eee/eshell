import {
  Activity,
  AlertTriangle,
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
import {
  panelVisibilityMarker,
  RailButton,
  StatusIndicator,
  ToggleSidebarButton,
  ToolbarSection,
} from "./top-toolbar/TopToolbarPrimitives";

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
            trailing={panelVisibilityMarker}
          />
          <RailButton
            icon={Activity}
            label={showStatusPanel ? "Hide status panel" : "Show status panel"}
            active={showStatusPanel}
            onClick={onToggleStatusPanel}
            collapsed={collapsed}
            trailing={panelVisibilityMarker}
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
