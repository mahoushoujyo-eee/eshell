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

function ActionButton({ icon: Icon, label, onClick, active = false }) {
  return (
    <button
      type="button"
      className={[
        "inline-flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors",
        active
          ? "border-accent bg-accent text-white"
          : "border-border bg-surface text-muted hover:bg-accent-soft hover:text-text",
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

  return (
    <aside className="panel-card flex h-full w-[248px] shrink-0 flex-col p-3">
      <div className="mb-4 border-b border-border/70 pb-3">
        <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-muted uppercase">
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          eShell
        </div>
        <div className="mt-1 text-base font-semibold">Operations Console</div>
      </div>

      <div className="mb-3">
        <div className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          Config
        </div>
        <div className="space-y-2">
          <button
            type="button"
            className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-accent-soft hover:text-text"
            onClick={onOpenSshConfig}
          >
            <Server className="h-4 w-4" aria-hidden="true" />
            SSH Profiles
          </button>
          <button
            type="button"
            className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-accent-soft hover:text-text"
            onClick={onOpenScriptConfig}
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            Script Center
          </button>
          <button
            type="button"
            className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-accent-soft hover:text-text"
            onClick={onOpenAiConfig}
          >
            <Bot className="h-4 w-4" aria-hidden="true" />
            AI Config
          </button>
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          Panels
        </div>
        <div className="space-y-1.5">
          <ActionButton icon={FolderOpen} label="SFTP" active={showSftpPanel} onClick={onToggleSftpPanel} />
          <ActionButton icon={Activity} label="Status" active={showStatusPanel} onClick={onToggleStatusPanel} />
          <ActionButton icon={Bot} label="AI Assistant" active={showAiPanel} onClick={onToggleAiPanel} />
        </div>
      </div>

      <div className="mt-auto space-y-1.5 border-t border-border/70 pt-3">
        <button
          type="button"
          className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft"
          onClick={onNextWallpaper}
        >
          <Image className="h-4 w-4" aria-hidden="true" />
          Wallpaper {wallpaper + 1}
        </button>
        <button
          type="button"
          className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft"
          onClick={onToggleTheme}
        >
          {theme === "light" ? <Moon className="h-4 w-4" aria-hidden="true" /> : <Sun className="h-4 w-4" aria-hidden="true" />}
          {theme === "light" ? "Dark Mode" : "Light Mode"}
        </button>
        <div className="rounded-md border border-border/80 bg-surface px-3 py-2 text-xs">
          <div className="inline-flex w-full items-center gap-1.5 text-muted">
            <LoaderCircle
              className={["h-3.5 w-3.5", busy ? "animate-spin text-accent" : ""].join(" ")}
              aria-hidden="true"
            />
            <span className="truncate">{busy ? `Running: ${busy}` : "Idle"}</span>
          </div>
          {hasError ? (
            <div className="mt-1 inline-flex w-full items-center gap-1.5 text-danger">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{error}</span>
            </div>
          ) : (
            <div className="mt-1 inline-flex w-full items-center gap-1.5 text-success">
              <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">No errors</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
