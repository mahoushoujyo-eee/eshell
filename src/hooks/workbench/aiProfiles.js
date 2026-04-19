import { DEFAULT_AI } from "../../constants/workbench";
import {
  getDefaultBaseUrlForApiType,
  normalizeAiApiType,
} from "../../lib/aiProviderTypes";

const parseNumber = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export const normalizeAiConfig = (config) => ({
  apiType: normalizeAiApiType(config?.apiType),
  baseUrl:
    config?.baseUrl ||
    getDefaultBaseUrlForApiType(normalizeAiApiType(config?.apiType)) ||
    DEFAULT_AI.baseUrl,
  apiKey: config?.apiKey || "",
  model: config?.model || DEFAULT_AI.model,
  systemPrompt: config?.systemPrompt || DEFAULT_AI.systemPrompt,
  temperature: parseNumber(config?.temperature, DEFAULT_AI.temperature),
  maxTokens: Math.max(1, Math.round(parseNumber(config?.maxTokens, DEFAULT_AI.maxTokens))),
  maxContextTokens: Math.max(
    1,
    Math.round(parseNumber(config?.maxContextTokens, DEFAULT_AI.maxContextTokens)),
  ),
  approvalMode:
    config?.approvalMode === "auto_execute"
      ? "auto_execute"
      : DEFAULT_AI.approvalMode,
});

const normalizeAiProfile = (profile) => ({
  id: profile?.id || "",
  name: (profile?.name || "").trim() || "Default",
  apiType: normalizeAiApiType(profile?.apiType),
  baseUrl:
    profile?.baseUrl ||
    getDefaultBaseUrlForApiType(normalizeAiApiType(profile?.apiType)) ||
    DEFAULT_AI.baseUrl,
  apiKey: profile?.apiKey || "",
  model: profile?.model || DEFAULT_AI.model,
  systemPrompt: profile?.systemPrompt || DEFAULT_AI.systemPrompt,
  temperature: parseNumber(profile?.temperature, DEFAULT_AI.temperature),
  maxTokens: Math.max(1, Math.round(parseNumber(profile?.maxTokens, DEFAULT_AI.maxTokens))),
  maxContextTokens: Math.max(
    1,
    Math.round(parseNumber(profile?.maxContextTokens, DEFAULT_AI.maxContextTokens)),
  ),
});

export const normalizeAiProfilesState = (state) => {
  const profiles = Array.isArray(state?.profiles)
    ? state.profiles.map(normalizeAiProfile).filter((item) => item.id)
    : [];
  const approvalMode = state?.approvalMode === "auto_execute" ? "auto_execute" : DEFAULT_AI.approvalMode;
  const activeFromState = state?.activeProfileId || null;
  const activeProfileId =
    activeFromState && profiles.some((item) => item.id === activeFromState)
      ? activeFromState
      : profiles[0]?.id || null;
  return {
    profiles,
    activeProfileId,
    approvalMode,
  };
};

export const toAiProfileInput = (profile) => ({
  id: profile.id || null,
  name: (profile.name || "").trim(),
  apiType: normalizeAiApiType(profile.apiType),
  baseUrl: profile.baseUrl,
  apiKey: profile.apiKey,
  model: profile.model,
  systemPrompt: profile.systemPrompt,
  temperature: Number(profile.temperature),
  maxTokens: Number(profile.maxTokens),
  maxContextTokens: Number(profile.maxContextTokens),
});

export const DEFAULT_AI_PROFILE_FORM = {
  id: null,
  name: "Default",
  apiType: DEFAULT_AI.apiType,
  baseUrl: DEFAULT_AI.baseUrl,
  apiKey: DEFAULT_AI.apiKey,
  model: DEFAULT_AI.model,
  systemPrompt: DEFAULT_AI.systemPrompt,
  temperature: DEFAULT_AI.temperature,
  maxTokens: DEFAULT_AI.maxTokens,
  maxContextTokens: DEFAULT_AI.maxContextTokens,
};
