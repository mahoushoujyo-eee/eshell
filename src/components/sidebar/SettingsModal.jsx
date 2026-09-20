import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  FileCog,
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
import PluginRemoveDialog from "./PluginRemoveDialog";

const TAB = Object.freeze({
  interface: "interface",
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
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
        active
          ? "bg-accent-soft font-medium text-accent"
          : "text-muted hover:bg-accent-soft/50 hover:text-text",
      ].join(" ")}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The heading above one section's rows in the content pane. */
function SectionHeading({ children }) {
  return (
    <h4 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
      {children}
    </h4>
  );
}

/** One labelled settings row with its control on the right. */
function Row({ icon: Icon, label, value, children }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-border/70 bg-surface/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" /> : null}
        <div className="min-w-0">
          <div className="text-xs font-medium text-text">{label}</div>
          {value ? <div className="truncate text-[10px] text-muted">{value}</div> : null}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Two-option segmented control; `options` is `[{ id, label, icon }]`. */
function Segmented({ options, activeId, onSelect }) {
  return (
    <div className="inline-flex rounded border border-border">
      {options.map((option) => {
        const active = option.id === activeId;
        const OptionIcon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            className={[
              "inline-flex items-center gap-1 px-2 py-1 text-[11px] transition-colors first:rounded-l last:rounded-r",
              active ? "bg-accent text-white" : "text-muted hover:bg-accent-soft/70",
            ].join(" ")}
            onClick={() => onSelect(option.id)}
            aria-pressed={active}
          >
            {OptionIcon ? <OptionIcon className="h-3 w-3" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function InterfaceTab({ theme, onSelectTheme, wallpaperLabel, onOpenWallpaperPicker }) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div className="space-y-4">
      <section>
        <SectionHeading>{t("Appearance")}</SectionHeading>
        <div className="space-y-2">
          <Row icon={Languages} label={t("Language")}>
            <Segmented
              options={[
                { id: "zh", label: "简体中文" },
                { id: "en", label: "English" },
              ]}
              activeId={language}
              onSelect={setLanguage}
            />
          </Row>

          <Row icon={theme === "light" ? Sun : Moon} label={t("Theme")}>
            <Segmented
              options={[
                { id: "light", label: t("Light Mode"), icon: Sun },
                { id: "dark", label: t("Dark Mode"), icon: Moon },
              ]}
              activeId={theme === "dark" ? "dark" : "light"}
              onSelect={onSelectTheme}
            />
          </Row>

          <Row icon={Image} label={t("Wallpaper")} value={wallpaperLabel}>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:bg-accent-soft"
              onClick={onOpenWallpaperPicker}
            >
              {t("Change")}
            </button>
          </Row>
        </div>
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
        <p className="text-[11px] leading-relaxed text-muted">
          {t("Plugins run in this app's context. Only install code you trust.")}
        </p>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent-soft disabled:opacity-40"
          onClick={install}
          disabled={busyId === "install"}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Install from folder…")}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-border bg-accent-soft/50 px-3 py-2 text-[11px] text-text">
          {notice}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-xs text-muted">{t("No extensions found.")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <Row
              key={row.id}
              label={row.displayName}
              value={`${row.id} · v${row.version} · ${row.builtin ? t("Built-in") : t("External")}`}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={[
                    "rounded-lg border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40",
                    row.enabled
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border text-muted",
                  ].join(" ")}
                  onClick={() => toggle(row)}
                  disabled={busyId === row.id}
                  aria-pressed={row.enabled}
                >
                  {row.enabled ? t("Enabled") : t("Disabled")}
                </button>
                {row.builtin ? null : (
                  <button
                    type="button"
                    className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    onClick={() => setConfirmRemove(row)}
                    disabled={busyId === row.id}
                    title={t("Delete this plugin's folder")}
                  >
                    {t("Remove")}
                  </button>
                )}
              </div>
            </Row>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted">
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
        <p className="text-[11px] leading-relaxed text-muted">
          {t(
            "Re-read config files you edited outside the app, without restarting. Reloading does not restart anything: open sessions keep their connection.",
          )}
        </p>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent-soft disabled:opacity-40"
          onClick={() => reload(null)}
          disabled={Boolean(busy)}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${busy === "all" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {t("Reload all")}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger">
          {error}
        </div>
      ) : null}

      {files.length === 0 ? (
        <p className="text-xs text-muted">{t("No reloadable config files.")}</p>
      ) : null}

      {files.length > 0 ? (
        <div className="flex flex-col gap-2">
          {files.map((entry) => {
            const outcome = outcomeFor(entry.file);
            return (
              <Row
                key={entry.file}
                label={entry.pathHint}
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
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:bg-accent-soft disabled:opacity-40"
                    onClick={() => reload(entry.file)}
                    disabled={Boolean(busy)}
                  >
                    {t("Reload")}
                  </button>
                </div>
              </Row>
            );
          })}
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted">
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
      <Row label={t("Current version")} value={currentVersion ? `v${currentVersion}` : "—"}>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-60"
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

      {error ? (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          {t("Could not check for updates: {reason}", { reason: error })}
        </div>
      ) : null}

      {result && !result.updateAvailable ? (
        <div className="inline-flex items-center gap-1.5 rounded border border-border/70 bg-surface/40 px-3 py-2 text-xs text-muted">
          <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          {t("You are on the latest version.")}
        </div>
      ) : null}

      {result?.updateAvailable ? (
        <div className="space-y-2 rounded border border-accent/40 bg-accent-soft/40 px-3 py-2">
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
                  <div className="h-1.5 overflow-hidden rounded-full bg-border/50">
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
                      className="rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:bg-accent-soft"
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
                  className="rounded bg-accent px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90"
                  onClick={() => api.relaunchApp()}
                >
                  {t("Restart now")}
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded bg-accent px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90"
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
                    className="rounded bg-accent px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90"
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
                    className="rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:bg-accent-soft"
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
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState(TAB.interface);

  useEffect(() => {
    if (open) {
      setTab(TAB.interface);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const active = SECTIONS.find((entry) => entry.id === tab) ?? SECTIONS[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(640px,88vh)] w-full max-w-3xl overflow-hidden rounded-2xl border border-border/80 bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        {/* Left rail: one item per section. The rail is fixed-width and the
            content pane scrolls, so a long plugin list never moves the
            navigation. */}
        <nav
          className="flex w-44 shrink-0 flex-col border-r border-border/70 bg-surface/40 p-3"
          aria-label={t("Settings")}
        >
          <h3 id="settings-title" className="mb-3 px-1 text-sm font-semibold text-text">
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
          <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-4 pb-2">
            <h3 className="text-base font-semibold text-text">{t(active.section)}</h3>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-accent-soft"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Close")}
            </button>
          </div>

          <div className="scroll-region min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {tab === TAB.interface ? (
              <InterfaceTab
                theme={theme}
                onSelectTheme={onSelectTheme}
                wallpaperLabel={wallpaperLabel}
                onOpenWallpaperPicker={onOpenWallpaperPicker}
              />
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
    </div>
  );
}
