import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Image, Languages, LoaderCircle, Moon, RefreshCw, Sun, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";

const TAB = Object.freeze({ interface: "interface", version: "version" });

function TabButton({ active, label, onClick }) {
  return (
    <button
      type="button"
      className={[
        "rounded border px-2 py-1.5 text-xs transition-colors",
        active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted",
      ].join(" ")}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[420px] w-full max-w-lg flex-col rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
          <h3 id="settings-title" className="text-base font-semibold text-text">
            {t("Settings")}
          </h3>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-accent-soft"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Close")}
          </button>
        </div>

        <div className="mb-3 grid shrink-0 grid-cols-2 gap-2">
          <TabButton
            active={tab === TAB.interface}
            label={t("Interface")}
            onClick={() => setTab(TAB.interface)}
          />
          <TabButton
            active={tab === TAB.version}
            label={t("Version")}
            onClick={() => setTab(TAB.version)}
          />
        </div>

        <div className="scroll-region min-h-0 flex-1 overflow-y-auto pr-1">
          {tab === TAB.interface ? (
            <InterfaceTab
              theme={theme}
              onSelectTheme={onSelectTheme}
              wallpaperLabel={wallpaperLabel}
              onOpenWallpaperPicker={onOpenWallpaperPicker}
            />
          ) : (
            <VersionTab />
          )}
        </div>
      </div>
    </div>
  );
}
