import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  FileText,
  Key,
  Link,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import ProviderIcon from "../ai/ProviderIcon";
import {
  AI_API_TYPES,
  getAiProviderMeta,
  getDefaultBaseUrlForApiType,
  isKnownAiBaseUrl,
  normalizeAiApiType,
} from "../../lib/aiProviderTypes";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";

const EMPTY_AI_FORM = {
  id: null,
  name: "Default",
  apiType: "openai_chat_completions",
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
  sshConfigs = [],
  aiProfiles = [],
  activeAiProfileId,
  aiProfileForm,
  setAiProfileForm,
  onSaveAiProfile,
  onDeleteAiProfile,
  onSelectAiProfile,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("home");
  const [agentContextGlobal, setAgentContextGlobal] = useState("");
  const [agentContextServerId, setAgentContextServerId] = useState("");
  const [agentContextServer, setAgentContextServer] = useState("");
  const [agentContextBusy, setAgentContextBusy] = useState("");
  const [agentContextError, setAgentContextError] = useState("");

  useEffect(() => {
    if (open) {
      setMode("home");
      setAgentContextError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "context") {
      return;
    }

    let cancelled = false;
    setAgentContextBusy("load-global");
    api
      .getAgentContext(null)
      .then((result) => {
        if (!cancelled) {
          setAgentContextGlobal(result?.content || "");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentContextError(String(error || ""));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentContextBusy("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== "context") {
      return;
    }

    const firstServerId = sshConfigs[0]?.id || "";
    setAgentContextServerId((current) =>
      current && sshConfigs.some((item) => item.id === current) ? current : firstServerId,
    );
  }, [mode, open, sshConfigs]);

  useEffect(() => {
    if (!open || mode !== "context" || !agentContextServerId) {
      setAgentContextServer("");
      return;
    }

    let cancelled = false;
    setAgentContextBusy("load-server");
    api
      .getAgentContext(agentContextServerId)
      .then((result) => {
        if (!cancelled) {
          setAgentContextServer(result?.content || "");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentContextError(String(error || ""));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentContextBusy("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentContextServerId, mode, open]);

  if (!open) {
    return null;
  }

  const activeAiProfile = aiProfiles.find((item) => item.id === activeAiProfileId) || null;
  const activeProvider = activeAiProfile ? getAiProviderMeta(activeAiProfile.apiType) : null;

  const openCreateForm = () => {
    setAiProfileForm(EMPTY_AI_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setAiProfileForm(item);
    setMode("form");
  };

  const handleApiTypeChange = (nextType) => {
    const normalizedType = normalizeAiApiType(nextType);
    setAiProfileForm((prev) => {
      const currentBaseUrl = (prev.baseUrl || "").trim();
      const previousType = normalizeAiApiType(prev.apiType);
      const shouldReplaceBaseUrl =
        !currentBaseUrl ||
        isKnownAiBaseUrl(currentBaseUrl) ||
        currentBaseUrl === getDefaultBaseUrlForApiType(previousType);
      return {
        ...prev,
        apiType: normalizedType,
        baseUrl: shouldReplaceBaseUrl
          ? getDefaultBaseUrlForApiType(normalizedType)
          : prev.baseUrl,
      };
    });
  };

  const submitProfile = async (event) => {
    await onSaveAiProfile(event);
    setMode("models");
  };

  const saveGlobalAgentContext = async () => {
    setAgentContextBusy("save-global");
    setAgentContextError("");
    try {
      const saved = await api.saveAgentContext(null, agentContextGlobal);
      setAgentContextGlobal(saved?.content || "");
    } catch (error) {
      setAgentContextError(String(error || ""));
    } finally {
      setAgentContextBusy("");
    }
  };

  const saveServerAgentContext = async () => {
    if (!agentContextServerId) {
      return;
    }
    setAgentContextBusy("save-server");
    setAgentContextError("");
    try {
      const saved = await api.saveAgentContext(agentContextServerId, agentContextServer);
      setAgentContextServer(saved?.content || "");
    } catch (error) {
      setAgentContextError(String(error || ""));
    } finally {
      setAgentContextBusy("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("AI Configs")}
            </h3>
            <p className="text-xs text-muted">
              {t("AI settings are split into instructions and model profiles.")}
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

        {mode === "home" ? (
          <div className="overflow-hidden rounded-xl border border-border/75 bg-surface">
            <button
              type="button"
              className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-accent-soft/35"
              onClick={() => setMode("context")}
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-panel text-accent">
                <FileText className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t("AGENTS.md Config")}</div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {t("Global AGENTS.md")} / {t("Server AGENTS.md")}
                </div>
              </div>
              <div className="hidden shrink-0 text-xs text-muted sm:block">
                {t("Agent Context")}
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden="true" />
            </button>

            <div className="ml-16 h-px bg-border/70" />

            <button
              type="button"
              className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-accent-soft/35"
              onClick={() => setMode("models")}
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-panel text-accent">
                <Cpu className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t("Model Configs")}</div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {activeAiProfile
                    ? t("Active model: {model}", { model: activeAiProfile.model })
                    : t("No active model")}
                </div>
              </div>
              <div className="hidden shrink-0 items-center gap-2 text-xs text-muted sm:flex">
                <span>{t("Configured: {count}", { count: aiProfiles.length })}</span>
                {activeProvider ? (
                  <span className={["inline-flex rounded-full border px-1.5 py-0.5 text-[10px]", activeProvider.badgeClass].join(" ")}>
                    {activeProvider.shortLabel}
                  </span>
                ) : null}
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden="true" />
            </button>
          </div>
        ) : mode === "models" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                  onClick={() => setMode("home")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("Back")}
                </button>
                <span className="text-sm text-muted">
                  {t("Configured: {count}", { count: aiProfiles.length })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                  onClick={openCreateForm}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("New Config")}
                </button>
              </div>
            </div>
            <div className="max-h-[56vh] space-y-2 overflow-auto pr-1">
              {aiProfiles.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  {t("No AI configs yet.")}
                </div>
              ) : (
                aiProfiles.map((item) => {
                  const isActive = item.id === activeAiProfileId;
                  const provider = getAiProviderMeta(item.apiType);
                  return (
                    <div key={item.id} className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <ProviderIcon apiType={item.apiType} className="h-8 w-8" />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{item.name}</div>
                              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                                <span
                                  className={[
                                    "inline-flex rounded-full border px-1.5 py-0.5",
                                    provider.badgeClass,
                                  ].join(" ")}
                                >
                                  {provider.shortLabel}
                                </span>
                                <span className="truncate">{provider.label}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                        {isActive && (
                          <span className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
                            <Check className="h-3 w-3" aria-hidden="true" />
                            {t("Active")}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 truncate text-muted">
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
        ) : mode === "context" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">{t("AGENTS.md Config")}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("home")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </button>
            </div>

            {agentContextError ? (
              <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {agentContextError}
              </div>
            ) : null}

            <div className="grid max-h-[62vh] gap-3 overflow-auto pr-1 md:grid-cols-2">
              <section className="rounded-xl border border-border/70 bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{t("Global AGENTS.md")}</div>
                    <div className="text-[11px] text-muted">
                      {t("Injected into every Ops Agent conversation.")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-wait disabled:opacity-60"
                    onClick={saveGlobalAgentContext}
                    disabled={agentContextBusy === "save-global"}
                  >
                    <Save className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("Save")}
                  </button>
                </div>
                <textarea
                  className="h-56 w-full resize-none rounded border border-border bg-panel px-3 py-2 text-xs leading-5 text-text outline-none"
                  value={agentContextGlobal}
                  onChange={(event) => setAgentContextGlobal(event.target.value)}
                  placeholder={t("Global user context, preferences, project notes...")}
                />
              </section>

              <section className="rounded-xl border border-border/70 bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("Server AGENTS.md")}</div>
                    <div className="truncate text-[11px] text-muted">
                      {t("Injected when this server is bound to the conversation.")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={saveServerAgentContext}
                    disabled={!agentContextServerId || agentContextBusy === "save-server"}
                  >
                    <Save className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("Save")}
                  </button>
                </div>

                <select
                  className="mb-2 w-full rounded border border-border bg-panel px-2 py-1.5 text-sm"
                  value={agentContextServerId}
                  onChange={(event) => setAgentContextServerId(event.target.value)}
                  disabled={sshConfigs.length === 0}
                >
                  {sshConfigs.length === 0 ? (
                    <option value="">{t("No server profiles yet.")}</option>
                  ) : (
                    sshConfigs.map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.name || server.host}
                      </option>
                    ))
                  )}
                </select>

                <textarea
                  className="h-44 w-full resize-none rounded border border-border bg-panel px-3 py-2 text-xs leading-5 text-text outline-none disabled:opacity-60 md:h-56"
                  value={agentContextServer}
                  onChange={(event) => setAgentContextServer(event.target.value)}
                  placeholder={t("Server-specific context, paths, policies...")}
                  disabled={!agentContextServerId}
                />
              </section>
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
                onClick={() => setMode("models")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </button>
            </div>

            <form className="space-y-2" onSubmit={submitProfile}>
              <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-surface px-3 py-2">
                <ProviderIcon apiType={aiProfileForm.apiType} className="h-10 w-10" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {getAiProviderMeta(aiProfileForm.apiType).label}
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {getDefaultBaseUrlForApiType(aiProfileForm.apiType)}
                  </div>
                </div>
              </div>

              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder={t("Config name")}
                value={aiProfileForm.name}
                onChange={(event) => setAiProfileForm((prev) => ({ ...prev, name: event.target.value }))}
              />

              <select
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                value={normalizeAiApiType(aiProfileForm.apiType)}
                onChange={(event) => handleApiTypeChange(event.target.value)}
              >
                {Object.entries(AI_API_TYPES).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </select>

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
