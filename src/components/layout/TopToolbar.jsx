export default function TopToolbar({
  theme,
  wallpaper,
  isLeftDrawerOpen,
  showSftpPanel,
  showStatusPanel,
  showAiPanel,
  onToggleSftpPanel,
  onToggleStatusPanel,
  onToggleAiPanel,
  onToggleLeftDrawer,
  onNextWallpaper,
  onToggleTheme,
}) {
  return (
    <header className="panel-card flex items-center justify-between px-4 py-3">
      <div>
        <div className="text-sm font-semibold tracking-[0.2em] text-muted uppercase">eShell</div>
        <div className="text-lg font-semibold">FinalShell 风格运维工作台</div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={[
            "rounded-md border px-3 py-1.5 text-sm",
            showSftpPanel ? "border-accent bg-accent text-white" : "border-border bg-surface text-muted",
          ].join(" ")}
          onClick={onToggleSftpPanel}
        >
          {showSftpPanel ? "隐藏 SFTP" : "显示 SFTP"}
        </button>
        <button
          type="button"
          className={[
            "rounded-md border px-3 py-1.5 text-sm",
            showStatusPanel ? "border-accent bg-accent text-white" : "border-border bg-surface text-muted",
          ].join(" ")}
          onClick={onToggleStatusPanel}
        >
          {showStatusPanel ? "隐藏状态" : "显示状态"}
        </button>
        <button
          type="button"
          className={[
            "rounded-md border px-3 py-1.5 text-sm",
            showAiPanel ? "border-accent bg-accent text-white" : "border-border bg-surface text-muted",
          ].join(" ")}
          onClick={onToggleAiPanel}
        >
          {showAiPanel ? "隐藏 AI" : "显示 AI"}
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
          onClick={onToggleLeftDrawer}
        >
          {isLeftDrawerOpen ? "收起侧栏" : "展开侧栏"}
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
          onClick={onNextWallpaper}
        >
          壁纸 {wallpaper + 1}
        </button>
        <button
          type="button"
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
          onClick={onToggleTheme}
        >
          {theme === "light" ? "夜间模式" : "白天模式"}
        </button>
      </div>
    </header>
  );
}
