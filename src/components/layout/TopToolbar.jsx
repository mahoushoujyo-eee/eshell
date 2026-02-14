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
}) {
  return (
    <aside className="panel-card flex h-full w-[230px] shrink-0 flex-col p-3">
      <div className="mb-4 border-b border-border/70 pb-3">
        <div className="text-xs font-semibold tracking-[0.2em] text-muted uppercase">eShell</div>
        <div className="text-base font-semibold">运维工作台</div>
      </div>

      <div className="mb-3">
        <div className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          配置入口
        </div>
        <div className="space-y-2">
          <button
            type="button"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-muted hover:bg-accent-soft"
            onClick={onOpenSshConfig}
          >
            SSH 连接
          </button>
          <button
            type="button"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-muted hover:bg-accent-soft"
            onClick={onOpenScriptConfig}
          >
            脚本管理
          </button>
          <button
            type="button"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-muted hover:bg-accent-soft"
            onClick={onOpenAiConfig}
          >
            AI 配置
          </button>
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-2 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          面板
        </div>
        <div className="space-y-1.5">
          <button
            type="button"
            className={[
              "w-full rounded-md border px-3 py-1.5 text-sm",
              showSftpPanel
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-muted",
            ].join(" ")}
            onClick={onToggleSftpPanel}
          >
            {showSftpPanel ? "隐藏 SFTP" : "显示 SFTP"}
          </button>
          <button
            type="button"
            className={[
              "w-full rounded-md border px-3 py-1.5 text-sm",
              showStatusPanel
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-muted",
            ].join(" ")}
            onClick={onToggleStatusPanel}
          >
            {showStatusPanel ? "隐藏状态" : "显示状态"}
          </button>
          <button
            type="button"
            className={[
              "w-full rounded-md border px-3 py-1.5 text-sm",
              showAiPanel
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-muted",
            ].join(" ")}
            onClick={onToggleAiPanel}
          >
            {showAiPanel ? "隐藏 AI" : "显示 AI"}
          </button>
        </div>
      </div>

      <div className="mt-auto space-y-1.5 border-t border-border/70 pt-3">
        <button
          type="button"
          className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
          onClick={onNextWallpaper}
        >
          壁纸 {wallpaper + 1}
        </button>
        <button
          type="button"
          className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
          onClick={onToggleTheme}
        >
          {theme === "light" ? "夜间模式" : "白天模式"}
        </button>
      </div>
    </aside>
  );
}
