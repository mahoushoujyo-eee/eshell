import {
  Activity,
  AlertTriangle,
  Bot,
  CircleCheck,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Image,
  LoaderCircle,
  Moon,
  Server,
  Settings2,
  Sun,
} from "lucide-react";

function NavButton({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      className="inline-flex w-full items-center gap-2 rounded-md border border-border/75 bg-panel px-3 py-2 text-left text-sm text-muted transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-text"
      onClick={onClick}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );
}

function ActionButton({ icon: Icon, label, onClick, active = false }) {
  return (
    <button
      type="button"
      className={[
        "inline-flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors",
        active
          ? "border-accent bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]"
          : "border-border/75 bg-panel text-muted hover:border-accent/40 hover:bg-accent-soft hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-2">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {label}
      </span>
      {active ? <Eye className="h-4 w-4" aria-hidden="true" /> : <EyeOff className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}

export default function TopToolbar({
  theme,
  wallpaper,
  showSftpPanel,
  showStatusPanel,
  showAiPanel,
  onOpenSshConfig,
  onOpenScriptConfig,
  onOpenAiConfig,
  onToggleSftpPanel,
  onToggleStatusPanel,
  onToggleAiPanel,
  onNextWallpaper,
  onToggleTheme,
  busy,
  error,
}) {
  const hasError = Boolean(error && String(error).trim());
  const isWarning = hasError && /^warning[:：]/i.test(String(error).trim());
  const busyText = busy ? `Running: ${busy}` : "Idle";
  const errorText = hasError ? String(error).trim() : "No errors";

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-surface/95 px-2 py-2">
      <div className="rounded-lg border border-border/75 bg-panel/90 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
        <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-muted uppercase">
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          eShell
        </div>
        <div className="mt-1 text-base font-semibold">Operations Console</div>
      </div>

      <div className="mt-2 rounded-lg border border-border/70 bg-panel/70 p-2">
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          Config
        </div>
        <div className="space-y-1">
          <NavButton icon={Server} label="SSH Profiles" onClick={onOpenSshConfig} />
          <NavButton icon={FileText} label="Script Center" onClick={onOpenScriptConfig} />
          <NavButton icon={Bot} label="AI Config" onClick={onOpenAiConfig} />
        </div>
      </div>

      <div className="mt-2 rounded-lg border border-border/70 bg-panel/70 p-2">
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          Panels
        </div>
        <div className="space-y-1">
          <ActionButton icon={FolderOpen} label="SFTP" active={showSftpPanel} onClick={onToggleSftpPanel} />
          <ActionButton icon={Activity} label="Status" active={showStatusPanel} onClick={onToggleStatusPanel} />
          <ActionButton icon={Bot} label="AI Assistant" active={showAiPanel} onClick={onToggleAiPanel} />
        </div>
      </div>

      <div className="mt-auto pt-2">
        <div className="rounded-lg border border-border/70 bg-panel/70 p-2">
          <div className="space-y-1">
            <NavButton icon={Image} label={`Wallpaper ${wallpaper + 1}`} onClick={onNextWallpaper} />
            <NavButton
              icon={theme === "light" ? Moon : Sun}
              label={theme === "light" ? "Dark Mode" : "Light Mode"}
              onClick={onToggleTheme}
            />
          </div>

          <div className="mt-2 rounded-md border border-border/75 bg-surface/90 px-3 py-2 text-xs">
            <div
              className={[
                "inline-flex w-full items-center gap-1.5",
                busy ? "text-accent" : "text-muted",
              ].join(" ")}
              title={busyText}
            >
              <LoaderCircle
                className={["h-3.5 w-3.5", busy ? "animate-spin text-accent" : ""].join(" ")}
                aria-hidden="true"
              />
              <span className="truncate">{busyText}</span>
            </div>
            {hasError ? (
              <div
                className={[
                  "mt-1 inline-flex w-full items-center gap-1.5",
                  isWarning ? "text-warning" : "text-danger",
                ].join(" ")}
                title={errorText}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{errorText}</span>
              </div>
            ) : (
              <div className="mt-1 inline-flex w-full items-center gap-1.5 text-success" title={errorText}>
                <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{errorText}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
