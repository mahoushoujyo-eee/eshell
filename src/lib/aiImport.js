const AI_IMPORT_API_TYPES = new Set([
  "openai_chat_completions",
  "openai_responses",
  "anthropic_messages",
]);

const AI_IMPORT_SOURCE_KINDS = new Set(["claude_code", "codex", "custom_json"]);

const DEFAULT_AI_IMPORT_FORM = {
  apiType: "openai_chat_completions",
  baseUrl: "",
  apiKey: "",
  model: "",
  systemPrompt: "",
  temperature: 0.2,
  maxTokens: 800,
  maxContextTokens: 100000,
  notes: [],
};

const coerceNumber = (value, fallback) => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeAiImportSourceKind = (value) =>
  AI_IMPORT_SOURCE_KINDS.has(value) ? value : "custom_json";

export const normalizeAiImportSource = (source) => {
  if (!source || typeof source !== "object") {
    return null;
  }
  return {
    id: typeof source.id === "string" ? source.id : "",
    kind: normalizeAiImportSourceKind(source.kind),
    label: typeof source.label === "string" ? source.label : "",
    path: typeof source.path === "string" ? source.path : "",
    available: Boolean(source.available),
    note: typeof source.note === "string" && source.note ? source.note : null,
  };
};

export const normalizeAiImportSources = (list) =>
  Array.isArray(list) ? list.map(normalizeAiImportSource).filter(Boolean) : [];

export const normalizeAiImportCandidate = (candidate) => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const apiType = AI_IMPORT_API_TYPES.has(candidate.apiType)
    ? candidate.apiType
    : "openai_chat_completions";
  return {
    sourceId:
      typeof candidate.sourceId === "string" ? candidate.sourceId : "",
    sourceKind: normalizeAiImportSourceKind(candidate.sourceKind),
    sourceLabel:
      typeof candidate.sourceLabel === "string" ? candidate.sourceLabel : "",
    sourcePath:
      typeof candidate.sourcePath === "string" ? candidate.sourcePath : "",
    name: typeof candidate.name === "string" ? candidate.name : "",
    apiType,
    baseUrl: typeof candidate.baseUrl === "string" ? candidate.baseUrl : "",
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    model: typeof candidate.model === "string" ? candidate.model : "",
    temperature: coerceNumber(
      candidate.temperature,
      DEFAULT_AI_IMPORT_FORM.temperature,
    ),
    maxTokens: Math.max(
      1,
      Math.round(
        coerceNumber(candidate.maxTokens, DEFAULT_AI_IMPORT_FORM.maxTokens),
      ),
    ),
    maxContextTokens: Math.max(
      1,
      Math.round(
        coerceNumber(
          candidate.maxContextTokens,
          DEFAULT_AI_IMPORT_FORM.maxContextTokens,
        ),
      ),
    ),
    systemPrompt:
      typeof candidate.systemPrompt === "string"
        ? candidate.systemPrompt
        : "",
    notes: Array.isArray(candidate.notes)
      ? candidate.notes.map((note) => String(note || "")).filter(Boolean)
      : [],
  };
};

export const normalizeAiImportCandidates = (list) =>
  Array.isArray(list)
    ? list.map(normalizeAiImportCandidate).filter(Boolean)
    : [];

export const buildAiImportProfileForm = (candidate) => {
  const base = normalizeAiImportCandidate(candidate) || DEFAULT_AI_IMPORT_FORM;
  return {
    ...DEFAULT_AI_IMPORT_FORM,
    ...base,
    name: base.name,
  };
};

export const isAiImportCandidateReady = (candidate) => {
  if (!candidate) {
    return false;
  }
  return Boolean(
    (candidate.baseUrl || "").trim() && (candidate.model || "").trim(),
  );
};

export const describeAiImportSource = (source) => {
  const normalized = normalizeAiImportSource(source);
  if (!normalized) {
    return { id: "", label: "", kindLabel: "", pathLabel: "", available: false };
  }
  const kindLabel = {
    claude_code: "Claude Code",
    codex: "Codex",
    custom_json: "Custom",
  }[normalized.kind] || "Custom";
  return {
    id: normalized.id,
    label: normalized.label,
    kindLabel,
    pathLabel: normalized.path,
    available: normalized.available,
    note: normalized.note,
    kind: normalized.kind,
  };
};
