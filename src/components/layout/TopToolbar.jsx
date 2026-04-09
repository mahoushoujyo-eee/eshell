import {
  Activity,
  AlertTriangle,
  CircleCheck,
  FileText,
  FolderOpen,
  Image,
  Languages,
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
import { useI18n } from "../../lib/i18n";

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
  const { language, t, toggleLanguage } = useI18n();
  const hasError = Boolean(error && String(error).trim());
  const normalizedError = hasError ? String(error).trim() : "";
  const isWarning =
    hasError &&
    (/^warning/i.test(normalizedError) ||
      normalizedError ===
        t(
          "Warning: Server status polling failed for this cycle due to a transient network fluctuation. The app will retry automatically.",
        ));
  const busyText = busy ? t("Running: {busy}", { busy }) : t("Idle");
  const errorDetail = normalizedError;
  const errorText = hasError
    ? isWarning
      ? t("Background warning")
      : t("Recent issue")
    : t("No issues");
  const errorTitle = hasError ? errorDetail : errorText;
  const currentLanguageLabel = language === "zh" ? "简体中文" : "English";
  const nextLanguageLabel = language === "zh" ? "English" : "简体中文";

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
        {!collapsed ? <div className="mt-2 text-base font-semibold">{t("Operations Console")}</div> : null}
      </div>

      <div className="mt-2 space-y-2">
        <ToolbarSection title={t("Config")} collapsed={collapsed}>
          <RailButton icon={Server} label={t("SSH Profiles")} onClick={onOpenSshConfig} collapsed={collapsed} />
          <RailButton icon={FileText} label={t("Script Center")} onClick={onOpenScriptConfig} collapsed={collapsed} />
        </ToolbarSection>

        <ToolbarSection title={t("Panels")} collapsed={collapsed}>
          <RailButton
            icon={FolderOpen}
            label={showSftpPanel ? t("Hide SFTP panel") : t("Show SFTP panel")}
            active={showSftpPanel}
            onClick={onToggleSftpPanel}
            collapsed={collapsed}
            trailing={panelVisibilityMarker}
          />
          <RailButton
            icon={Activity}
            label={showStatusPanel ? t("Hide status panel") : t("Show status panel")}
            active={showStatusPanel}
            onClick={onToggleStatusPanel}
            collapsed={collapsed}
            trailing={panelVisibilityMarker}
          />
        </ToolbarSection>
      </div>

      <div className="mt-auto pt-2">
        <ToolbarSection title={t("Quick")} collapsed={collapsed}>
          <RailButton
            icon={Image}
            label={wallpaperLabel ? t("Wallpaper: {label}", { label: wallpaperLabel }) : t("Wallpaper")}
            onClick={onOpenWallpaperPicker}
            collapsed={collapsed}
          />
          <RailButton
            icon={theme === "light" ? Moon : Sun}
            label={theme === "light" ? t("Dark Mode") : t("Light Mode")}
            onClick={onToggleTheme}
            collapsed={collapsed}
          />
          <RailButton
            icon={Languages}
            label={t("Language: {language}", { language: currentLanguageLabel })}
            onClick={toggleLanguage}
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
          {!collapsed ? (
            <div className="px-1 text-[10px] text-muted">
              {t("Switch to {language}", { language: nextLanguageLabel })}
            </div>
          ) : null}
        </ToolbarSection>
      </div>
    </aside>
  );
}
