import {
  Activity,
  AlertTriangle,
  Bot,
  CircleCheck,
  FileText,
  FolderOpen,
  LoaderCircle,
  NotebookPen,
  Server,
  Settings,
  Settings2,
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
  showSftpPanel,
  showStatusPanel,
  showCommandDraftPanel,
  collapsed = false,
  onToggleCollapsed,
  onOpenSshConfig,
  onOpenScriptConfig,
  onOpenAgentConfig,
  onToggleSftpPanel,
  onToggleStatusPanel,
  onToggleCommandDraftPanel,
  onOpenSettings,
  busy,
  error,
}) {
  const { t } = useI18n();
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
            <div className="inline-flex items-center gap-2 text-sm text-muted">
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              {!collapsed ? <span className="brand-wordmark">eShell</span> : null}
            </div>
          </div>
          <ToggleSidebarButton collapsed={collapsed} onClick={onToggleCollapsed} />
        </div>
      </div>

      <div className="mt-2 space-y-2">
        <ToolbarSection title={t("Config")} collapsed={collapsed}>
          <RailButton icon={Server} label={t("SSH Profiles")} onClick={onOpenSshConfig} collapsed={collapsed} />
          <RailButton icon={FileText} label={t("Script Center")} onClick={onOpenScriptConfig} collapsed={collapsed} />
          <RailButton icon={Bot} label={t("Agent Config")} onClick={onOpenAgentConfig} collapsed={collapsed} />
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
          <RailButton
            icon={NotebookPen}
            label={showCommandDraftPanel ? t("Hide command draft") : t("Show command draft")}
            active={showCommandDraftPanel}
            onClick={onToggleCommandDraftPanel}
            collapsed={collapsed}
            trailing={panelVisibilityMarker}
          />
        </ToolbarSection>
      </div>

      <div className="mt-auto pt-2">
        <ToolbarSection title={t("Quick")} collapsed={collapsed}>
          <RailButton
            icon={Settings}
            label={t("Settings")}
            onClick={onOpenSettings}
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
