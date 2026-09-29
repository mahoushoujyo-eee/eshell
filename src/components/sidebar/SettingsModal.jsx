import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  FileCog,
  FilePen,
  Image,
  Info,
  Languages,
  LoaderCircle,
  Moon,
  Palette,
  Plus,
  Puzzle,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";
import Button, { buttonClass, IconButton } from "../ui/Button";
import Dialog from "../ui/Dialog";
import SegmentedControl from "../ui/SegmentedControl";
import Switch from "../ui/Switch";
import { sectionLabelClass } from "../ui/fieldClasses";
import PluginRemoveDialog from "./PluginRemoveDialog";

const TAB = Object.freeze({
  interface: "interface",
  editor: "editor",
  plugins: "plugins",
  config: "config",
  version: "version",
});

/**
 * The settings sections, in navigation order. Each entry is one left-rail
 * item; `section` is the heading rendered above its group in the content
 * pane, so the rail and the pane cannot drift apart.
 */
const SECTIONS = [
  { id: TAB.interface, label: "Interface", icon: Palette, section: "Appearance" },
  { id: TAB.editor, label: "File Editor", icon: FilePen, section: "File Editor" },
  { id: TAB.plugins, label: "Plugins", icon: Puzzle, section: "Extensions" },
  { id: TAB.config, label: "Config Files", icon: FileCog, section: "Config Files" },
  { id: TAB.version, label: "Version", icon: Info, section: "About" },
];

/**
 * One left-rail navigation item. `active` uses the accent fill the rest of
 * the app uses for a selected row, so the current section is unmistakable
 * without a separate indicator element.
 */
function NavItem({ icon: Icon, label, active, onClick }) {
  return (
    <button
      type="button"
      className={[
        "relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors duration-150",
        active
          ? "bg-accent-soft font-medium text-text before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent before:content-['']"
          : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={["h-4 w-4 shrink-0", active ? "text-accent" : ""].join(" ")} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The heading above one section's rows in the content pane. */
function SectionHeading({ children }) {
  return <h4 className={`mb-2 ${sectionLabelClass}`}>{children}</h4>;
}

/** A bordered group of rows separated by hairlines. */
function RowGroup({ children }) {
  return <div className="divide-y divide-border rounded-lg border border-border bg-panel">{children}</div>;
}

/** One labelled settings row with its control on the right. */
function Row({ icon: Icon, label, value, children }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> : null}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-text">{label}</div>
          {value ? <div className="truncate text-[11px] text-muted">{value}</div> : null}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Inline status message under a section heading. */
function Callout({ tone = "neutral", children }) {
  const toneClass =
    tone === "danger"
      ? "border-danger/35 bg-danger/10 text-danger"
      : tone === "accent"
        ? "border-accent/30 bg-accent-soft text-text"
        : "border-border bg-panel text-muted";
  return <div className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${toneClass}`}>{children}</div>;
}

function InterfaceTab({ theme, onSelectTheme, wallpaperLabel, onOpenWallpaperPicker }) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div className="space-y-4">
      <section>
        <SectionHeading>{t("Appearance")}</SectionHeading>
        <RowGroup>
          <Row icon={Languages} label={t("Language")}>
            <SegmentedControl
              options={[
                { id: "zh", label: "简体中文" },
                { id: "en", label: "English" },
              ]}
              value={language}
              onChange={setLanguage}
            />
          </Row>

          <Row icon={theme === "light" ? Sun : Moon} label={t("Theme")}>
            <SegmentedControl
              options={[
                { id: "light", label: t("Light Mode"), icon: Sun },
                { id: "dark", label: t("Dark Mode"), icon: Moon },
              ]}
              value={theme === "dark" ? "dark" : "light"}
              onChange={onSelectTheme}
            />
          </Row>

          <Row icon={Image} label={t("Wallpaper")} value={wallpaperLabel}>
            <Button variant="secondary" size="xs" onClick={onOpenWallpaperPicker}>
              {t("Change")}
            </Button>
          </Row>
        </RowGroup>
      </section>
    </div>
  );
}

function FileEditorTab({ autoSync, onAutoSyncChange }) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <section>
        <SectionHeading>{t("File Editor")}</SectionHeading>
        <RowGroup>
          <Row icon={RefreshCw} label={t("Auto sync")} value={t("When on, edited files are saved automatically.")}>
            <Switch checked={autoSync} onChange={onAutoSyncChange} label={t("Auto sync")} />
          </Row>
        </RowGroup>
      </section>
    </div>
  );
}

/**
 * Plugins tab: the merged builtin + external extension catalog.
 *
 * Builtin extensions can only be toggled — their code ships with the app.
 * External plugins can also be removed, and new ones installed by picking a
 * directory. Installing runs the plugin's code in this app's JS context, so
 * the picker carries an explicit trust warning rather than implying a sandbox.
 */
function PluginsTab() {
  const { t } = useI18n();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listExtensions();
      setRows(Array.isArray(list) ? list : []);
      setError("");
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (row) => {
    setBusyId(row.id);
    setError("");
    setNotice("");
    try {
      const next = await api.setExtensionEnabled(row.id, !row.enabled);
      setRows(Array.isArray(next) ? next : []);
    } catch (cause) {
      // A disable can be refused while an operation is in flight; the
      // backend's message says so, so surface it rather than a generic one.
      setError(String(cause?.message ?? cause));
    } finally {
      setBusyId("");
    }
  };

  const install = async () => {
    setError("");
    setNotice("");
    try {
      const picked = await api.selectDirectory();
      if (!picked) {
        return;
      }
      setBusyId("install");
      const result = await api.installExtension(picked);
      setRows(Array.isArray(result?.extensions) ? result.extensions : []);
      // `t` interpolates `{name}` itself; replacing it again would look for a
      // placeholder that is already gone.
      setNotice(t("Installed {name}", { name: result?.displayName ?? "" }));
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    } finally {
      setBusyId("");
    }
  };

  const remove = async (row) => {
    setBusyId(row.id);
    setError("");
    setNotice("");
    try {
      const next = await api.uninstallExtension(row.id);
      setRows(Array.isArray(next) ? next : []);
      setNotice(t("Removed {name}", { name: row.displayName }));
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    } finally {
      setBusyId("");
      setConfirmRemove(null);
    }
  };

  // The dialog is rendered as a sibling of the list, not inside a row, so a
  // list refresh while it is open cannot unmount it mid-confirmation.
  const confirmDialog = (
    <PluginRemoveDialog
      plugin={confirmRemove}
      busy={Boolean(confirmRemove) && busyId === confirmRemove.id}
      onCancel={() => setConfirmRemove(null)}
      onConfirm={() => remove(confirmRemove)}
    />
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("Loading")}
      </div>
    );
  }

  const externalCount = rows.filter((row) => !row.builtin).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>{t("Extensions")}</SectionHeading>

      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted">
          {t("Plugins run in this app's context. Only install code you trust.")}
        </p>
        <Button variant="secondary" onClick={install} disabled={busyId === "install"}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Install from folder…")}
        </Button>
      </div>

      {error ? <Callout tone="danger">{error}</Callout> : null}
      {notice ? <Callout tone="accent">{notice}</Callout> : null}

      {rows.length === 0 ? (
        <p className="text-xs text-muted">{t("No extensions found.")}</p>
      ) : (
        <RowGroup>
          {rows.map((row) => (
            <Row
              key={row.id}
              icon={Puzzle}
              label={row.displayName}
              value={`${row.id} · v${row.version} · ${row.builtin ? t("Built-in") : t("External")}`}
            >
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className={[
                    "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:opacity-40",
                    row.enabled
                      ? "border-accent/35 bg-accent-soft text-accent"
                      : "border-border-strong text-muted hover:bg-hover",
                  ].join(" ")}
                  onClick={() => toggle(row)}
                  disabled={busyId === row.id}
                  aria-pressed={row.enabled}
                >
                  {row.enabled ? t("Enabled") : t("Disabled")}
                </button>
                {row.builtin ? null : (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="hover:bg-danger/10 hover:text-danger"
                    onClick={() => setConfirmRemove(row)}
                    disabled={busyId === row.id}
                    title={t("Delete this plugin's folder")}
                  >
                    {t("Remove")}
                  </Button>
                )}
              </div>
            </Row>
          ))}
        </RowGroup>
      )}

      <p className="text-[11px] text-subtle">
        {t("{count} external plugins installed.", { count: externalCount })}
      </p>

      {confirmDialog}
    </div>
  );
}

/**
 * Config Files tab: re-read `.eshell-data` JSON that was edited outside the
 * app.
 *
 * Every reloadable file is listed with its own Reload button plus one
 * Reload all, because a user who hand-edited one file usually wants that one.
 * Each row reports what happened: a file that is missing keeps its current
 * value, and a file that fails to parse is reported rather than applied, so
 * a half-written file never silently empties the app's state.
 *
 * Reloading restarts nothing. An open SSH session keeps its connection (a new
 * profile applies to the next connection), and this pane says so rather than
 * implying that reload equals reconnect.
 */
function ConfigTab() {
  const { t } = useI18n();
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .listReloadableConfigs()
      .then((list) => {
        if (!cancelled) {
          setFiles(Array.isArray(list) ? list : []);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(String(cause?.message ?? cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async (file) => {
    setBusy(file ?? "all");
    setError("");
    try {
      const outcomes = await api.reloadConfig(file);
      setResults(Array.isArray(outcomes) ? outcomes : []);
    } catch (cause) {
      setError(String(cause?.message ?? cause));
      setResults(null);
    } finally {
      setBusy("");
    }
  }, []);

  const outcomeFor = (file) => results?.find((row) => row.file === file);

  /** One sentence per file: what actually happened to it. */
  const describe = (outcome) => {
    if (outcome.error) {
      return { tone: "danger", text: t("Could not apply: {reason}", { reason: outcome.error }) };
    }
    if (outcome.missing) {
      return { tone: "muted", text: t("File not found — the current value was kept.") };
    }
    if (outcome.changed) {
      return { tone: "success", text: t("Reloaded with changes.") };
    }
    return { tone: "muted", text: t("Reloaded, nothing changed.") };
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("Loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>{t("Config Files")}</SectionHeading>

      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted">
          {t(
            "Re-read config files you edited outside the app, without restarting. Reloading does not restart anything: open sessions keep their connection.",
          )}
        </p>
        <Button variant="secondary" onClick={() => reload(null)} disabled={Boolean(busy)}>
          <RefreshCw
            className={`h-3.5 w-3.5 ${busy === "all" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {t("Reload all")}
        </Button>
      </div>

      {error ? <Callout tone="danger">{error}</Callout> : null}

      {files.length === 0 ? (
        <p className="text-xs text-muted">{t("No reloadable config files.")}</p>
      ) : null}

      {files.length > 0 ? (
        <RowGroup>
          {files.map((entry) => {
            const outcome = outcomeFor(entry.file);
            return (
              <Row
                key={entry.file}
                icon={FileCog}
                label={<span className="font-mono text-xs">{entry.pathHint}</span>}
                value={t("Reloadable while the app is running")}
              >
                <div className="flex items-center gap-2">
                  {outcome ? (
                    <span
                      className={`max-w-[16rem] truncate text-[11px] ${
                        describe(outcome).tone === "danger"
                          ? "text-danger"
                          : describe(outcome).tone === "success"
                            ? "text-success"
                            : "text-muted"
                      }`}
                      title={describe(outcome).text}
                    >
                      {describe(outcome).text}
                    </span>
                  ) : null}
                  <Button variant="secondary" size="xs" onClick={() => reload(entry.file)} disabled={Boolean(busy)}>
                    {t("Reload")}
                  </Button>
                </div>
              </Row>
            );
          })}
        </RowGroup>
      ) : null}

      <p className="text-[11px] leading-relaxed text-subtle">
        {t(
          "A missing file keeps its current value, and a file that fails to parse is reported instead of applied — a half-written file cannot clear your settings.",
        )}
      </p>
    </div>
  );
}

function VersionTab() {
  const { t } = useI18n();
  const [currentVersion, setCurrentVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  // In-app (signature-verified) update state. `updaterReady` is only true when
  // the plugin initialized cleanly, which requires a real pubkey in the config.
  const [updaterReady, setUpdaterReady] = useState(false);
  const [updaterUpdate, setUpdaterUpdate] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [progress, setProgress] = useState({ downloaded: 0, contentLength: null });
  const [installError, setInstallError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .appVersion()
      .then((version) => {
        if (!cancelled) {
          setCurrentVersion(String(version || ""));
        }
      })
      .catch(() => {
        // Falls back to whatever a completed check reports.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setError("");
    setInstalled(false);
    setInstallError("");
    try {
      // Preferred path: the updater plugin, which also proves itself here.
      // Its rejection (placeholder pubkey, old installer, offline) falls back
      // to the plain GitHub release lookup below.
      let update = null;
      try {
        update = await api.updaterCheck();
        setUpdaterReady(Boolean(update));
      } catch {
        setUpdaterReady(false);
      }
      setUpdaterUpdate(update);

      // The GitHub lookup always runs so release notes and the release-page
      // link stay available even when the in-app install is not.
      const next = await api.checkAppUpdate();
      setResult(next);
      if (next?.currentVersion) {
        setCurrentVersion(next.currentVersion);
      }
      // Only offer the in-app install when the plugin saw a newer version too;
      // the two feeds can disagree while a release propagates.
      if (update && next?.updateAvailable) {
        setProgress({ downloaded: 0, contentLength: null });
      }
    } catch (err) {
      setError(typeof err === "string" ? err : err?.message || String(err));
      setResult(null);
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!updaterUpdate) {
      return;
    }
    setInstalling(true);
    setInstallError("");
    try {
      await api.updaterDownloadAndInstall(updaterUpdate, (event) => {
        setProgress((prev) => ({
          downloaded: prev.downloaded + (event.downloaded ?? 0),
          contentLength: event.contentLength ?? prev.contentLength,
        }));
      });
      setInstalled(true);
    } catch (err) {
      setInstallError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setInstalling(false);
    }
  }, [updaterUpdate]);

  const asset = result?.asset || null;
  const inAppInstall = result?.updateAvailable && updaterReady && !installed;
  const percent =
    progress.contentLength > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
      : null;

  return (
    <div className="space-y-4">
      <SectionHeading>{t("About")}</SectionHeading>
      <div className="space-y-2">
      <RowGroup>
      <Row icon={Info} label={t("Current version")} value={currentVersion ? `v${currentVersion}` : "—"}>
        <button
          type="button"
          className={buttonClass({ variant: "primary" })}
          onClick={check}
          disabled={checking || installing}
        >
          {checking || installing ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {checking || installing ? t("Checking...") : t("Check for updates")}
        </button>
      </Row>
      </RowGroup>

      {error ? (
        <div className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
          {t("Could not check for updates: {reason}", { reason: error })}
        </div>
      ) : null}

      {result && !result.updateAvailable ? (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-3 py-2 text-xs text-muted">
          <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          {t("You are on the latest version.")}
        </div>
      ) : null}

      {result?.updateAvailable ? (
        <div className="space-y-2.5 rounded-lg border border-accent/30 bg-accent-soft px-3.5 py-3">
          <div className="text-xs font-medium text-text">
            {t("Version {version} is available.", { version: result.latestVersion })}
          </div>

          {inAppInstall ? (
            <>
              {installing ? (
                <div className="space-y-1">
                  <div className="text-[11px] text-muted">
                    {percent === null
                      ? t("Downloading update...")
                      : t("Downloading update...") + ` ${percent}%`}
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-warm">
                    <div
                      className="h-full rounded-full bg-accent transition-[width]"
                      style={{ width: `${percent === null ? 100 : percent}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {installed ? (
                <div className="inline-flex items-center gap-1.5 text-xs text-text">
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  {t("Update installed.")}
                  {t("Restart to finish the update.")}
                </div>
              ) : null}
              {installError ? (
                <div className="space-y-2">
                  <div className="text-xs text-danger">
                    {t("In-app update install failed: {reason}", { reason: installError })}
                  </div>
                  {/* Keep a way out when the signed channel is broken (e.g. the
                     release was built before the pubkey was configured). */}
                  {asset ? (
                    <button
                      type="button"
                      className={buttonClass({ variant: "secondary", size: "xs" })}
                      onClick={() => openUrl(asset.downloadUrl)}
                    >
                      {t("Download {name}", { name: asset.name })}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {installed ? (
                <button
                  type="button"
                  className={buttonClass({ variant: "primary" })}
                  onClick={() => api.relaunchApp()}
                >
                  {t("Restart now")}
                </button>
              ) : (
                <button
                  type="button"
                  className={buttonClass({ variant: "primary" })}
                  onClick={install}
                >
                  {t("Install update")}
                </button>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {asset ? (
                  <button
                    type="button"
                    className={buttonClass({ variant: "primary" })}
                    onClick={() => openUrl(asset.downloadUrl)}
                  >
                    {t("Download {name}", { name: asset.name })}
                  </button>
                ) : (
                  <span className="text-[11px] text-muted">
                    {t("No installer for this platform in the latest release.")}
                  </span>
                )}
                {result.releaseUrl ? (
                  <button
                    type="button"
                    className={buttonClass({ variant: "secondary", size: "xs" })}
                    onClick={() => openUrl(result.releaseUrl)}
                  >
                    {t("Open release page")}
                  </button>
                ) : null}
              </div>

              {!updaterReady ? (
                <p className="text-[10px] leading-relaxed text-muted">
                  {t(
                    "Signature-verified in-app install is not configured yet; the download opens in your browser.",
                  )}
                </p>
              ) : null}
            </>
          )}

          {result.releaseNotes ? (
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer">{t("Release notes")}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans">
                {result.releaseNotes}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}

export default function SettingsModal({
  open,
  onClose,
  theme,
  onSelectTheme,
  wallpaperLabel,
  onOpenWallpaperPicker,
  fileAutoSync = false,
  onFileAutoSyncChange,
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState(TAB.interface);

  useEffect(() => {
    if (open) {
      setTab(TAB.interface);
    }
  }, [open]);

  const active = SECTIONS.find((entry) => entry.id === tab) ?? SECTIONS[0];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="h-[min(640px,88vh)]"
      labelledBy="settings-title"
    >
      <div className="flex min-h-0 flex-1">
        {/* Left rail: one item per section. The rail is fixed-width and the
            content pane scrolls, so a long plugin list never moves the
            navigation. */}
        <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface p-2" aria-label={t("Settings")}>
          <h3 id="settings-title" className="px-2.5 pt-2 pb-3 text-sm font-semibold text-text">
            {t("Settings")}
          </h3>
          <div className="flex flex-col gap-0.5">
            {SECTIONS.map((entry) => (
              <NavItem
                key={entry.id}
                icon={entry.icon}
                label={t(entry.label)}
                active={entry.id === tab}
                onClick={() => setTab(entry.id)}
              />
            ))}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pr-3 pl-5">
            <h3 className="text-sm font-semibold text-text">{t(active.section)}</h3>
            <IconButton label={t("Close")} onClick={onClose}>
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>

          <div className="scroll-region min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === TAB.interface ? (
              <InterfaceTab
                theme={theme}
                onSelectTheme={onSelectTheme}
                wallpaperLabel={wallpaperLabel}
                onOpenWallpaperPicker={onOpenWallpaperPicker}
              />
            ) : tab === TAB.editor ? (
              <FileEditorTab autoSync={fileAutoSync} onAutoSyncChange={onFileAutoSyncChange} />
            ) : tab === TAB.plugins ? (
              <PluginsTab />
            ) : tab === TAB.config ? (
              <ConfigTab />
            ) : (
              <VersionTab />
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
