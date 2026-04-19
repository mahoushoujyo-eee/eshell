export const AI_API_TYPES = {
  openai_chat_completions: {
    label: "OpenAI Chat Completions",
    shortLabel: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    accentClass: "text-[#111827]",
    badgeClass: "border-[#d7dde7] bg-white text-[#111827]",
  },
  openai_responses: {
    label: "OpenAI Responses",
    shortLabel: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    accentClass: "text-[#111827]",
    badgeClass: "border-[#d7dde7] bg-white text-[#111827]",
  },
  anthropic_messages: {
    label: "Anthropic Messages",
    shortLabel: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    accentClass: "text-[#8b5e3c]",
    badgeClass: "border-[#ead7c7] bg-[#fff8f2] text-[#8b5e3c]",
  },
};

export const DEFAULT_AI_API_TYPE = "openai_chat_completions";

export const normalizeAiApiType = (value) =>
  Object.prototype.hasOwnProperty.call(AI_API_TYPES, value) ? value : DEFAULT_AI_API_TYPE;

export const getAiProviderMeta = (apiType) =>
  AI_API_TYPES[normalizeAiApiType(apiType)] || AI_API_TYPES[DEFAULT_AI_API_TYPE];

export const getDefaultBaseUrlForApiType = (apiType) =>
  getAiProviderMeta(apiType).baseUrl;

export const isKnownAiBaseUrl = (value) => {
  const current = (value || "").trim().replace(/\/+$/, "");
  if (!current) {
    return false;
  }
  return Object.values(AI_API_TYPES).some((item) => item.baseUrl === current);
};
