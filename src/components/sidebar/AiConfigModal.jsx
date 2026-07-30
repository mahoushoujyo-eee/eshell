import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  Download,
  FileText,
  Key,
  Link,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ProviderIcon from "../ai/ProviderIcon";
import {
  AI_API_TYPES,
  getAiProviderMeta,
  getDefaultBaseUrlForApiType,
  isKnownAiBaseUrl,
  normalizeAiApiType,
} from "../../lib/aiProviderTypes";
import {
  buildAiImportProfileForm,
  describeAiImportSource,
  isAiImportCandidateReady,
  normalizeAiImportCandidate,
  normalizeAiImportCandidates,
  normalizeAiImportSource,
  normalizeAiImportSources,
} from "../../lib/aiImport";
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
  onImportAiProfiles,
  onNotice,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("home");
  const [agentContextGlobal, setAgentContextGlobal] = useState("");
  const [agentContextServerId, setAgentContextServerId] = useState("");
  const [agentContextServer, setAgentContextServer] = useState("");
  const [agentContextBusy, setAgentContextBusy] = useState("");
  const [agentContextError, setAgentContextError] = useState("");
  const [importStep, setImportStep] = useState("source");
  const [importSources, setImportSources] = useState([]);
  const [importSourcesBusy, setImportSourcesBusy] = useState(false);
  const [importSourcesError, setImportSourcesError] = useState("");
  const [importCustomPath, setImportCustomPath] = useState("");
  const [importSelectedSource, setImportSelectedSource] = useState(null);
  const [importCandidates, setImportCandidates] = useState([]);
  const [importWarnings, setImportWarnings] = useState([]);
  const [importSelectedIds, setImportSelectedIds] = useState({});
  const [importEdits, setImportEdits] = useState({});
  const [importDetectBusy, setImportDetectBusy] = useState(false);
  const [importDetectError, setImportDetectError] = useState("");
  const [importCommitBusy, setImportCommitBusy] = useState(false);
  const [importCommitResult, setImportCommitResult] = useState(null);

  const showImportNotice = (message, tone = "info") => {
    if (typeof onNotice === "function") {
      onNotice(message, tone);
      return;
    }
    if (tone === "danger" || tone === "warning") {
      setImportDetectError(message);
    }
  };

  useEffect(() => {
    if (open) {
      setMode("home");
      setAgentContextError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "import") {
      return;
    }
    setImportDetectError("");
    if (importStep === "source") {
      loadImportSources();
    }
  }, [mode, open, importStep]);

  const loadImportSources = async () => {
    setImportSourcesBusy(true);
    setImportSourcesError("");
    try {
      const result = await api.listAiImportSources([]);
      setImportSources(normalizeAiImportSources(result?.sources || []));
    } catch (error) {
      setImportSourcesError(String(error || ""));
    } finally {
      setImportSourcesBusy(false);
    }
  };

  const addCustomImportPath = async () => {
    const trimmed = importCustomPath.trim();
    if (!trimmed) {
      return;
    }
    setImportSourcesBusy(true);
    setImportSourcesError("");
    try {
      const result = await api.listAiImportSources([trimmed]);
      const normalized = normalizeAiImportSources(result?.sources || []);
      setImportSources((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const next = [...prev];
        for (const source of normalized) {
          if (!seen.has(source.id)) {
            next.push(source);
            seen.add(source.id);
          }
        }
        return next;
      });
      setImportCustomPath("");
    } catch (error) {
      setImportSourcesError(String(error || ""));
    } finally {
      setImportSourcesBusy(false);
    }
  };

  const resetImportState = () => {
    setImportStep("source");
    setImportSources([]);
    setImportSourcesError("");
    setImportCustomPath("");
    setImportSelectedSource(null);
    setImportCandidates([]);
    setImportWarnings([]);
    setImportSelectedIds({});
    setImportEdits({});
    setImportDetectError("");
    setImportCommitResult(null);
  };

  const selectImportSource = async (source) => {
    const normalized = normalizeAiImportSource(source);
    if (!normalized || !normalized.available) {
      return;
    }
    setImportSelectedSource(normalized);
    setImportDetectError("");
    setImportDetectBusy(true);
    setImportCandidates([]);
    setImportWarnings([]);
    setImportSelectedIds({});
    setImportEdits({});
    setImportStep("review");
    try {
      const result = await api.detectAiImportCandidates(normalized);
      const candidates = normalizeAiImportCandidates(result?.candidates || []);
      setImportCandidates(candidates);
      setImportWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      const selected = {};
      candidates.forEach((candidate, index) => {
        selected[index] = isAiImportCandidateReady(candidate);
      });
      setImportSelectedIds(selected);
    } catch (error) {
      setImportDetectError(String(error || ""));
    } finally {
      setImportDetectBusy(false);
    }
  };

  const commitImport = async () => {
    if (!importCandidates.length) {
      return;
    }
    const selected = importCandidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => importSelectedIds[index])
      .map(({ candidate, index }) => {
        const editKey = `${candidate.sourceId}:${candidate.name}:${index}`;
        const edit = importEdits[editKey];
        const merged = edit ? { ...candidate, ...edit } : candidate;
        return buildAiImportProfileForm(merged);
      });
    if (selected.length === 0) {
      setImportDetectError(
        t("Select at least one candidate before importing."),
      );
      return;
    }
    setImportCommitBusy(true);
    setImportDetectError("");
    try {
      const result = await onImportAiProfiles?.(selected);
      if (result === undefined) {
        setImportDetectError(
          t("Import handler is not ready. Please reopen this dialog and try again."),
        );
        return;
      }
      if (result === null) {
        return;
      }
      setImportCommitResult({
        imported: Array.isArray(result.imported) ? result.imported : [],
        skipped: Array.isArray(result.skipped) ? result.skipped : [],
      });
      setImportStep("done");
    } catch (error) {
      setImportDetectError(String(error || ""));
    } finally {
      setImportCommitBusy(false);
    }
  };

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
                  className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs"
                  onClick={() => {
                    resetImportState();
                    setMode("import");
                  }}
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("Import")}
                </button>
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
        ) : mode === "import" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                  onClick={() => {
                    resetImportState();
                    setMode("models");
                  }}
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("Back")}
                </button>
                <span className="text-sm text-muted">{t("Import AI Config")}</span>
              </div>
            </div>

            {importDetectError ? (
              <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {importDetectError}
              </div>
            ) : null}

            {importStep === "source" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted">
                  {t(
                    "Pick a source to detect AI provider settings, or import a custom JSON file.",
                  )}
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface px-3 py-2">
                  <input
                    className="flex-1 rounded border border-border bg-panel px-2 py-1.5 text-sm"
                    placeholder={t("Custom JSON or JSONC path")}
                    value={importCustomPath}
                    onChange={(event) => setImportCustomPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomImportPath();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                    onClick={addCustomImportPath}
                    disabled={!importCustomPath.trim() || importSourcesBusy}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("Add path")}
                  </button>
                </div>

                {importSourcesError ? (
                  <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {importSourcesError}
                  </div>
                ) : null}

                <div className="max-h-[44vh] space-y-2 overflow-auto pr-1">
                  {importSourcesBusy ? (
                    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/80 bg-surface px-3 py-3 text-xs text-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {t("Scanning for AI configs...")}
                    </div>
                  ) : null}
                  {!importSourcesBusy && importSources.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                      {t("No AI config sources detected on this machine.")}
                    </div>
                  ) : null}
                  {importSources.map((source) => {
                    const meta = describeAiImportSource(source);
                    return (
                      <button
                        key={source.id}
                        type="button"
                        className={[
                          "flex w-full items-start gap-3 rounded-lg border bg-surface px-3 py-2 text-left transition",
                          source.available
                            ? "border-border/70 hover:border-accent/50 hover:bg-accent-soft/35"
                            : "border-border/60 opacity-70",
                        ].join(" ")}
                        onClick={() => selectImportSource(source)}
                        disabled={!source.available}
                      >
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border/70 bg-panel text-accent">
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">
                            {meta.label || meta.kindLabel}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted">
                            {meta.pathLabel || meta.kindLabel}
                          </div>
                          {!source.available ? (
                            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
                              <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                              {source.note || t("Source unavailable")}
                            </div>
                          ) : null}
                        </div>
                        <span className="rounded-full border border-border/70 bg-panel px-2 py-0.5 text-[10px] text-muted">
                          {meta.kindLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : importStep === "review" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"
                    onClick={() => {
                      setImportStep("source");
                      setImportSelectedSource(null);
                      setImportCandidates([]);
                      setImportWarnings([]);
                      setImportDetectError("");
                    }}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("Back to sources")}
                  </button>
                  {importSelectedSource ? (
                    <span className="truncate">
                      {t("Source: {label}", {
                        label: importSelectedSource.label,
                      })}
                    </span>
                  ) : null}
                </div>

                {importDetectBusy ? (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/80 bg-surface px-3 py-3 text-xs text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t("Reading provider settings...")}
                  </div>
                ) : null}

                {!importDetectBusy && importCandidates.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                    {t("No AI provider settings found in this source.")}
                  </div>
                ) : null}

                {importWarnings.length > 0 ? (
                  <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                    {importWarnings.map((warning, index) => (
                      <div key={`warn-${index}`}>{warning}</div>
                    ))}
                  </div>
                ) : null}

                <div className="max-h-[44vh] space-y-2 overflow-auto pr-1">
                  {importCandidates.map((candidate, index) => {
                    const editKey = `${candidate.sourceId}:${candidate.name}:${index}`;
                    const edit = importEdits[editKey] || candidate;
                    const ready = isAiImportCandidateReady(edit);
                    return (
                      <div
                        key={editKey}
                        className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs"
                      >
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1 h-3.5 w-3.5 accent-accent"
                            checked={Boolean(importSelectedIds[index])}
                            onChange={(event) =>
                              setImportSelectedIds((prev) => ({
                                ...prev,
                                [index]: event.target.checked,
                              }))
                            }
                            disabled={!ready}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <ProviderIcon
                                apiType={edit.apiType}
                                className="h-7 w-7"
                              />
                              <input
                                className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1 text-sm"
                                value={edit.name}
                                onChange={(event) =>
                                  setImportEdits((prev) => ({
                                    ...prev,
                                    [editKey]: {
                                      ...edit,
                                      name: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <select
                                className="rounded border border-border bg-panel px-2 py-1 text-sm"
                                value={normalizeAiApiType(edit.apiType)}
                                onChange={(event) =>
                                  setImportEdits((prev) => ({
                                    ...prev,
                                    [editKey]: {
                                      ...edit,
                                      apiType: event.target.value,
                                    },
                                  }))
                                }
                              >
                                {Object.entries(AI_API_TYPES).map(
                                  ([value, meta]) => (
                                    <option key={value} value={value}>
                                      {meta.label}
                                    </option>
                                  ),
                                )}
                              </select>
                              <div className="relative">
                                <Link className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                                <input
                                  className="w-full rounded border border-border bg-panel px-7 py-1 text-sm"
                                  value={edit.baseUrl}
                                  placeholder={t("Base URL")}
                                  onChange={(event) =>
                                    setImportEdits((prev) => ({
                                      ...prev,
                                      [editKey]: {
                                        ...edit,
                                        baseUrl: event.target.value,
                                      },
                                    }))
                                  }
                                />
                              </div>
                            </div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <div className="relative">
                                <Key className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                                <input
                                  type="password"
                                  className="w-full rounded border border-border bg-panel px-7 py-1 text-sm"
                                  value={edit.apiKey}
                                  placeholder={t("API key (leave blank to fill later)")}
                                  onChange={(event) =>
                                    setImportEdits((prev) => ({
                                      ...prev,
                                      [editKey]: {
                                        ...edit,
                                        apiKey: event.target.value,
                                      },
                                    }))
                                  }
                                />
                              </div>
                              <input
                                className="rounded border border-border bg-panel px-2 py-1 text-sm"
                                value={edit.model}
                                placeholder={t("Model")}
                                onChange={(event) =>
                                  setImportEdits((prev) => ({
                                    ...prev,
                                    [editKey]: {
                                      ...edit,
                                      model: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </div>
                            {Array.isArray(edit.notes) && edit.notes.length > 0 ? (
                              <ul className="mt-2 space-y-0.5 text-[11px] text-warning">
                                {edit.notes.map((note, noteIndex) => (
                                  <li key={`note-${noteIndex}`}>{note}</li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        </label>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={commitImport}
                    disabled={
                      importCommitBusy ||
                      !importCandidates.some(
                        (_, index) => importSelectedIds[index],
                      )
                    }
                  >
                    {importCommitBusy ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Download
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    )}
                    {t("Import selected")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {importCommitResult ? (
                  <div className="space-y-2">
                    {importCommitResult.imported.length > 0 ? (
                      <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                        {t("Imported {count} profile(s).", {
                          count: importCommitResult.imported.length,
                        })}
                      </div>
                    ) : null}
                    {importCommitResult.skipped.length > 0 ? (
                      <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                        <div className="font-medium">
                          {t("Skipped {count} entry(ies):", {
                            count: importCommitResult.skipped.length,
                          })}
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {importCommitResult.skipped.map((note, index) => (
                            <li key={`skipped-${index}`}>{note}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                    onClick={() => {
                      resetImportState();
                      setMode("models");
                    }}
                  >
                    {t("Done")}
                  </button>
                </div>
              </div>
            )}
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
