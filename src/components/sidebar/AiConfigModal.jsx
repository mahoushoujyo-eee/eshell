import { ArrowLeft, Bot, Check, Key, Link, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";

const EMPTY_AI_FORM = {
  id: null,
  name: "Default",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.",
  temperature: 0.2,
  maxTokens: 800,
  maxContextTokens: 100000,
};

export default function AiConfigModal({
  open,
  onClose,
  aiProfiles,
  activeAiProfileId,
  aiProfileForm,
  setAiProfileForm,
  onSaveAiProfile,
  onDeleteAiProfile,
  onSelectAiProfile,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("list");

  useEffect(() => {
    if (open) {
      setMode("list");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const openCreateForm = () => {
    setAiProfileForm(EMPTY_AI_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setAiProfileForm(item);
    setMode("form");
  };

  const submitProfile = async (event) => {
    await onSaveAiProfile(event);
    setMode("list");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("AI Configs")}
            </h3>
            <p className="text-xs text-muted">
              {t("Manage model profiles and pick one for conversation.")}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Close")}
          </button>
        </div>

        {mode === "list" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {t("Configured: {count}", { count: aiProfiles.length })}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={openCreateForm}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("New Config")}
              </button>
            </div>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {aiProfiles.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  {t("No AI configs yet.")}
                </div>
              ) : (
                aiProfiles.map((item) => {
                  const isActive = item.id === activeAiProfileId;
                  return (
                    <div key={item.id} className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{item.name}</div>
                        {isActive && (
                          <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
                            <Check className="h-3 w-3" aria-hidden="true" />
                            {t("Active")}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-muted">
                        {item.model} - {item.baseUrl}
                      </div>
                      <div className="mt-2 flex gap-1">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => onSelectAiProfile(item.id)}
                          disabled={isActive}
                        >
                          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                          {isActive ? t("In Use") : t("Use")}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"
                          onClick={() => openEditForm(item)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("Edit")}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-danger"
                          onClick={() => onDeleteAiProfile(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("Delete")}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {aiProfileForm.id ? t("Edit config") : t("New config")}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </button>
            </div>

            <form className="space-y-2" onSubmit={submitProfile}>
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder={t("Config name")}
                value={aiProfileForm.name}
                onChange={(event) => setAiProfileForm((prev) => ({ ...prev, name: event.target.value }))}
              />

              <div className="relative">
                <Link className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                <input
                  className="w-full rounded border border-border bg-surface px-7 py-1.5 text-sm"
                  placeholder={t("Base URL")}
                  value={aiProfileForm.baseUrl}
                  onChange={(event) => setAiProfileForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                />
              </div>

              <div className="relative">
                <Key className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                <input
                  type="password"
                  className="w-full rounded border border-border bg-surface px-7 py-1.5 text-sm"
                  placeholder={t("API key")}
                  value={aiProfileForm.apiKey}
                  onChange={(event) => setAiProfileForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("Model")}
                  value={aiProfileForm.model}
                  onChange={(event) => setAiProfileForm((prev) => ({ ...prev, model: event.target.value }))}
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("Temperature")}
                  value={aiProfileForm.temperature}
                  onChange={(event) => setAiProfileForm((prev) => ({ ...prev, temperature: event.target.value }))}
                />
              </div>

              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder={t("Max tokens")}
                value={aiProfileForm.maxTokens}
                onChange={(event) => setAiProfileForm((prev) => ({ ...prev, maxTokens: event.target.value }))}
              />

              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder={t("Max context tokens")}
                value={aiProfileForm.maxContextTokens}
                onChange={(event) =>
                  setAiProfileForm((prev) => ({ ...prev, maxContextTokens: event.target.value }))
                }
              />

              <textarea
                className="h-24 w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder={t("System prompt")}
                value={aiProfileForm.systemPrompt}
                onChange={(event) => setAiProfileForm((prev) => ({ ...prev, systemPrompt: event.target.value }))}
              />

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {aiProfileForm.id ? t("Update Config") : t("Create Config")}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
