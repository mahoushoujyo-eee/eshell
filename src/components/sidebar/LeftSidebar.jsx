export default function LeftSidebar({
  isOpen,
  onCollapse,
  sshConfigs,
  sshForm,
  setSshForm,
  onSaveSsh,
  onConnectServer,
  onDeleteSsh,
  scripts,
  scriptForm,
  setScriptForm,
  onSaveScript,
  onRunScript,
  onDeleteScript,
  aiConfig,
  setAiConfig,
  onSaveAi,
}) {
  return (
    <aside
      className={[
        "h-full overflow-auto p-3 transition-opacity duration-200",
        isOpen ? "opacity-100" : "pointer-events-none opacity-0",
      ].join(" ")}
    >
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted hover:bg-accent-soft"
          onClick={onCollapse}
        >
          收起
        </button>
      </div>

      <section className="mb-3 rounded-xl border border-border/80 bg-panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">SSH 连接</h2>
          <span className="rounded bg-accent-soft px-2 py-0.5 text-xs text-muted">{sshConfigs.length}</span>
        </div>
        <div className="max-h-42 space-y-2 overflow-auto">
          {sshConfigs.map((item) => (
            <div key={item.id} className="rounded border border-border/70 bg-surface px-2 py-2 text-xs">
              <div className="font-medium">{item.name}</div>
              <div className="text-muted">
                {item.username}@{item.host}:{item.port}
              </div>
              <div className="mt-2 flex gap-1">
                <button
                  type="button"
                  className="rounded bg-accent px-2 py-1 text-white"
                  onClick={() => onConnectServer(item.id)}
                >
                  连接
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1"
                  onClick={() => setSshForm(item)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="rounded border border-danger/40 px-2 py-1 text-danger"
                  onClick={() => onDeleteSsh(item.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>

        <form className="mt-3 space-y-2" onSubmit={onSaveSsh}>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="名称"
              value={sshForm.name}
              onChange={(event) => setSshForm((prev) => ({ ...prev, name: event.target.value }))}
            />
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="主机"
              value={sshForm.host}
              onChange={(event) => setSshForm((prev) => ({ ...prev, host: event.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="端口"
              value={sshForm.port}
              onChange={(event) => setSshForm((prev) => ({ ...prev, port: event.target.value }))}
            />
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="用户名"
              value={sshForm.username}
              onChange={(event) =>
                setSshForm((prev) => ({ ...prev, username: event.target.value }))
              }
            />
          </div>
          <input
            type="password"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            placeholder="密码"
            value={sshForm.password}
            onChange={(event) => setSshForm((prev) => ({ ...prev, password: event.target.value }))}
          />
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">
            {sshForm.id ? "更新" : "新增"}
          </button>
        </form>
      </section>

      <section className="mb-3 rounded-xl border border-border/80 bg-panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">脚本管理</h2>
          <span className="rounded bg-accent-soft px-2 py-0.5 text-xs text-muted">{scripts.length}</span>
        </div>
        <div className="max-h-32 space-y-2 overflow-auto">
          {scripts.map((item) => (
            <div key={item.id} className="rounded border border-border/70 bg-surface px-2 py-2 text-xs">
              <div className="font-medium">{item.name}</div>
              <div className="truncate text-muted">{item.command || item.path}</div>
              <div className="mt-2 flex gap-1">
                <button
                  type="button"
                  className="rounded bg-accent px-2 py-1 text-white"
                  onClick={() => onRunScript(item.id)}
                >
                  运行
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1"
                  onClick={() => setScriptForm(item)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="rounded border border-danger/40 px-2 py-1 text-danger"
                  onClick={() => onDeleteScript(item.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>

        <form className="mt-3 space-y-2" onSubmit={onSaveScript}>
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            placeholder="脚本名称"
            value={scriptForm.name}
            onChange={(event) => setScriptForm((prev) => ({ ...prev, name: event.target.value }))}
          />
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            placeholder="脚本路径"
            value={scriptForm.path}
            onChange={(event) => setScriptForm((prev) => ({ ...prev, path: event.target.value }))}
          />
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            placeholder="执行命令"
            value={scriptForm.command}
            onChange={(event) =>
              setScriptForm((prev) => ({ ...prev, command: event.target.value }))
            }
          />
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">
            {scriptForm.id ? "更新" : "新增"}
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-border/80 bg-panel p-3">
        <h2 className="mb-2 text-sm font-semibold">AI 配置</h2>
        <form className="space-y-2" onSubmit={onSaveAi}>
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            placeholder="Base URL"
            value={aiConfig.baseUrl}
            onChange={(event) => setAiConfig((prev) => ({ ...prev, baseUrl: event.target.value }))}
          />
          <input
            type="password"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            placeholder="API Key"
            value={aiConfig.apiKey}
            onChange={(event) => setAiConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Model"
              value={aiConfig.model}
              onChange={(event) => setAiConfig((prev) => ({ ...prev, model: event.target.value }))}
            />
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Temp"
              value={aiConfig.temperature}
              onChange={(event) =>
                setAiConfig((prev) => ({ ...prev, temperature: event.target.value }))
              }
            />
          </div>
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">
            保存 AI 配置
          </button>
        </form>
      </section>
    </aside>
  );
}
