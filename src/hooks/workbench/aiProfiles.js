import { DEFAULT_AI } from "../../constants/workbench";

const parseNumber = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export const normalizeAiConfig = (config) => ({
  baseUrl: config?.baseUrl || DEFAULT_AI.baseUrl,
  apiKey: config?.apiKey || "",
  model: config?.model || DEFAULT_AI.model,
  systemPrompt: config?.systemPrompt || DEFAULT_AI.systemPrompt,
  temperature: parseNumber(config?.temperature, DEFAULT_AI.temperature),
  maxTokens: Math.max(1, Math.round(parseNumber(config?.maxTokens, DEFAULT_AI.maxTokens))),
});

const normalizeAiProfile = (profile) => ({
  id: profile?.id || "",
  name: (profile?.name || "").trim() || "Default",
  ...normalizeAiConfig(profile),
});

export const normalizeAiProfilesState = (state) => {
  const profiles = Array.isArray(state?.profiles)
    ? state.profiles.map(normalizeAiProfile).filter((item) => item.id)
    : [];
  const activeFromState = state?.activeProfileId || null;
  const activeProfileId =
    activeFromState && profiles.some((item) => item.id === activeFromState)
      ? activeFromState
      : profiles[0]?.id || null;
  return {
    profiles,
    activeProfileId,
  };
};

export const toAiProfileInput = (profile) => ({
  id: profile.id || null,
  name: (profile.name || "").trim(),
  baseUrl: profile.baseUrl,
  apiKey: profile.apiKey,
  model: profile.model,
  systemPrompt: profile.systemPrompt,
  temperature: Number(profile.temperature),
  maxTokens: Number(profile.maxTokens),
});

export const DEFAULT_AI_PROFILE_FORM = {
  id: null,
  name: "Default",
  ...DEFAULT_AI,
};
