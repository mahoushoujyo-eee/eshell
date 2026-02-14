export default function AiConfigModal({
  open,
  onClose,
  aiConfig,
  setAiConfig,
  onSaveAi,
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">AI 配置</h3>
            <p className="text-xs text-muted">配置模型参数和服务地址</p>
          </div>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
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
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-xs"
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">
              保存 AI 配置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
