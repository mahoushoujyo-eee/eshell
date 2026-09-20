import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  CircleCheck,
  Cloud,
  Container,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  LoaderCircle,
  Monitor,
  Network,
  NotebookPen,
  Package,
  Puzzle,
  Rocket,
  Server,
  Settings,
  Shield,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import {
  panelVisibilityMarker,
  RailButton,
  StatusIndicator,
  ToggleSidebarButton,
  ToolbarSection,
} from "./top-toolbar/TopToolbarPrimitives";
import { useI18n } from "../../lib/i18n";
// Brand mark cropped from `docs/assets/Shell.png` (cube + `$`), text removed so
// it can sit next to the wordmark without repeating "Shell".
import eshellMark from "../../assets/eshell-mark.png";
import { getPlugin, resolveToolbarContributions } from "../../plugins";
import { useRegistryVersion } from "../../plugins/runtime/useRegistry";

// Panel id → the rail icon it used before the plugin split. Icons live with
// the toolbar (not the plugin) because they are chrome, not feature logic.
const PANEL_TOOLBAR_ICONS = {
  sftp: FolderOpen,
  status: Activity,
};

const PANEL_TOOLBAR_LABELS = {
  sftp: {
    show: "Show SFTP panel",
    hide: "Hide SFTP panel",
  },
  status: {
    show: "Show status panel",
    hide: "Hide status panel",
  },
};

// External toolbar icons by name. A plugin supplies a string; an unknown
// name falls back to Puzzle, so a typo never blanks the rail button.
//
// The set is deliberately closed: a plugin cannot hand the host an arbitrary
// component, and a name that is not here is a typo rather than a new icon.
// Plugins that want their own artwork should pass a URL instead (see below).
const EXTERNAL_TOOLBAR_ICONS = {
  box: Package,
  boxes: Boxes,
  cloud: Cloud,
  container: Container,
  cpu: Cpu,
  database: Database,
  git: GitBranch,
  globe: Globe,
  harddrive: HardDrive,
  layers: Layers,
  monitor: Monitor,
  network: Network,
  package: Package,
  puzzle: Puzzle,
  rocket: Rocket,
  server: Server,
  shield: Shield,
  terminal: Terminal,
  wrench: Wrench,
  zap: Zap,
};

// A plugin-supplied icon URL. Only the plugin protocol and data URLs are
// accepted: an `http(s):` URL would make the app fetch a remote image on
// every render (a tracking beacon the user never asked for), and a
// `javascript:` URL is a script-injection vector. The plugin protocol is
// same-origin with the app, so a plugin's own bundled asset loads without
// widening what the app is willing to fetch.
const SAFE_ICON_URL = /^(https?:\/\/plugin\.localhost\/|plugin:\/\/|data:image\/)/i;

/** An accepted image URL, or null when it is refused. */
const safeIconUrl = (value) => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return SAFE_ICON_URL.test(trimmed) ? trimmed : null;
};

/** Renders a plugin-supplied image icon. The URL is validated by the caller. */
function PluginImageIcon({ src }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0 object-contain"
      draggable={false}
    />
  );
}

/**
 * A renderable React component: an element (a `$$typeof`-tagged object, which
 * is also what a lucide icon is) or a plain function component.
 */
const isRenderable = (value) =>
  typeof value === "function" ||
  (Boolean(value) && typeof value === "object" && value.$$typeof !== undefined);

/**
 * Resolves one toolbar contribution's `icon` to something renderable.
 *
 * Accepted, in order:
 * - a host React element or component (a plugin that imported nothing can
 *   pass one, and a lucide icon from the host's own React tree is one);
 * - a `{ src }` object or a URL string pointing at the plugin's own asset;
 * - a name from the closed set above.
 *
 * Anything else falls back to Puzzle. The return value is always renderable,
 * so a bad icon never blanks the button — including a `{ src }` whose URL is
 * refused, which falls back rather than rendering an empty image.
 */
export const externalToolbarIcon = (icon) => {
  if (isRenderable(icon)) {
    return icon;
  }
  if (icon && typeof icon === "object") {
    // `{ src }` is the documented way to hand over an image; anything else
    // object-shaped that is not a React element is not renderable.
    const src = safeIconUrl(icon.src);
    if (src) {
      const Image = () => <PluginImageIcon src={src} />;
      return Image;
    }
    return Puzzle;
  }
  if (typeof icon === "string") {
    const src = safeIconUrl(icon);
    if (src) {
      const Image = () => <PluginImageIcon src={src} />;
      return Image;
    }
    const named = EXTERNAL_TOOLBAR_ICONS[icon.trim().toLowerCase()];
    if (named) {
      return named;
    }
  }
  return Puzzle;
};

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
  extensions,
  workbench,
}) {
  const { t } = useI18n();
  // Re-resolve toolbar contributions when the registry changes (a late
  // external registration or a disable), not only on workbench re-renders.
  useRegistryVersion();
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

  // Plugin-contributed panel toggles, in manifest order (sftp, then status,
  // then externals). A disabled extension contributes nothing: the button
  // disappears until the extension is re-enabled. The command-draft toggle is
  // app chrome and stays.
  //
  // Builtin panels keep their original icons, translated labels, order and
  // the workbench's onToggleX callback. External panels get the generic
  // toggle surface (visibility map + hide/show label from the contribution),
  // so a new panel key needs no hardcoded map entry here.
  const panelVisibility = {
    sftp: showSftpPanel,
    status: showStatusPanel,
    ...(workbench?.panelVisibility || {}),
  };
  const panelToggles = {
    sftp: onToggleSftpPanel,
    status: onToggleStatusPanel,
  };
  const genericToggle = (key) => () => workbench?.togglePanel?.(key);
  const contributedPanels = resolveToolbarContributions(extensions)
    .filter((item) => item.enabled)
    .map((item) => {
      const plugin = getPlugin(item.pluginId);
      if (!plugin) {
        return null;
      }
      if (plugin.builtin === false) {
        // External contribution: icon/label from the contribution, the
        // generic visibility map, the plugin's own toggle if it declared an
        // action, otherwise the generic panel toggle.
        const toggle =
          typeof item.onClick === "function"
            ? item.onClick
            : item.panelId
              ? genericToggle(item.panelId)
              : null;
        if (!toggle) {
          return null;
        }
        return {
          key: item.key,
          icon: externalToolbarIcon(item.icon),
          label: item.label ? t(item.label) : item.key,
          visible: panelVisibility[item.panelId || item.key] === true,
          onToggle: toggle,
          actionOnly: typeof item.onClick === "function" && !item.panelId,
        };
      }
      if (!panelToggles[item.key]) {
        // An unknown builtin key (manifest drift) renders nothing rather
        // than a dead button.
        return null;
      }
      // Builtin panels keep their original icon, translated label and the
      // workbench's onToggleX callback, byte-for-byte.
      return {
        key: item.key,
        icon: PANEL_TOOLBAR_ICONS[item.key],
        labels: PANEL_TOOLBAR_LABELS[item.key],
        visible: panelVisibility[item.key] === true,
        onToggle: panelToggles[item.key],
        actionOnly: false,
      };
    })
    .filter(Boolean);

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
              {/* Transparent-background mark, no wrapper of its own so it sits
                  directly on whatever the rail's background happens to be. */}
              <img
                src={eshellMark}
                alt=""
                className={collapsed ? "h-6 w-6 shrink-0" : "h-[18px] w-[18px] shrink-0"}
                draggable={false}
              />
              {!collapsed ? <span className="brand-wordmark">eShell</span> : null}
            </div>
          </div>
          <ToggleSidebarButton collapsed={collapsed} onClick={onToggleCollapsed} />
        </div>
      </div>

      {/* `min-h-0` lets the Panels section shrink and scroll instead of
          pushing the Quick section off the bottom of the rail. */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
        <ToolbarSection title={t("Config")} collapsed={collapsed}>
          <RailButton icon={Server} label={t("SSH Profiles")} onClick={onOpenSshConfig} collapsed={collapsed} />
          <RailButton icon={FileText} label={t("Script Center")} onClick={onOpenScriptConfig} collapsed={collapsed} />
          <RailButton icon={Bot} label={t("Agent Config")} onClick={onOpenAgentConfig} collapsed={collapsed} />
        </ToolbarSection>

        <ToolbarSection title={t("Panels")} collapsed={collapsed} scroll>
          {contributedPanels.map((panel) => (
            <RailButton
              key={panel.key}
              icon={panel.icon}
              label={
                panel.actionOnly
                  ? panel.label
                  : panel.labels
                    ? panel.visible
                      ? t(panel.labels.hide)
                      : t(panel.labels.show)
                    : panel.visible
                      ? `${t("Hide")} ${panel.label}`
                      : `${t("Show")} ${panel.label}`
              }
              active={panel.actionOnly ? false : panel.visible}
              onClick={panel.onToggle}
              collapsed={collapsed}
              trailing={panel.actionOnly ? null : panelVisibilityMarker}
            />
          ))}
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

      <div className="shrink-0 pt-2">
        <ToolbarSection title={t("Quick")} collapsed={collapsed}>
          <RailButton
            icon={Settings}
            label={t("Settings")}
            onClick={onOpenSettings}
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
