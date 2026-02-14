import { Bot, Key, Link, Save, SlidersHorizontal, X } from "lucide-react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
              AI Settings
            </h3>
            <p className="text-xs text-muted">Configure model endpoint and generation parameters.</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Close
          </button>
        </div>

        <form className="space-y-2" onSubmit={onSaveAi}>
          <div className="relative">
            <Link className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              className="w-full rounded border border-border bg-surface px-7 py-1.5 text-sm"
              placeholder="Base URL"
              value={aiConfig.baseUrl}
              onChange={(event) => setAiConfig((prev) => ({ ...prev, baseUrl: event.target.value }))}
            />
          </div>
          <div className="relative">
            <Key className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              type="password"
              className="w-full rounded border border-border bg-surface px-7 py-1.5 text-sm"
              placeholder="API Key"
              value={aiConfig.apiKey}
              onChange={(event) => setAiConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Model"
              value={aiConfig.model}
              onChange={(event) => setAiConfig((prev) => ({ ...prev, model: event.target.value }))}
            />
            <div className="relative">
              <SlidersHorizontal className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                className="w-full rounded border border-border bg-surface px-7 py-1.5 text-sm"
                placeholder="Temp"
                value={aiConfig.temperature}
                onChange={(event) => setAiConfig((prev) => ({ ...prev, temperature: event.target.value }))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-xs"
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white">
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              Save AI Settings
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
