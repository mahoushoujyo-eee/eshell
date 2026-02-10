export const WALLPAPERS = [
  "none",
  "radial-gradient(circle at 14% 14%, rgba(87, 176, 149, 0.22), transparent 26%), radial-gradient(circle at 87% 21%, rgba(201, 154, 90, 0.18), transparent 38%)",
  "linear-gradient(115deg, rgba(12, 40, 36, 0.45), rgba(147, 99, 64, 0.24))",
];

export const EMPTY_SSH = {
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  password: "",
  description: "",
};

export const EMPTY_SCRIPT = {
  id: null,
  name: "",
  path: "",
  command: "",
  description: "",
};

export const DEFAULT_AI = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.",
  temperature: 0.2,
  maxTokens: 800,
};
