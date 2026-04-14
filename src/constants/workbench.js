export const WALLPAPER_PRESETS = [
  {
    id: "none",
    name: "Plain Terminal",
    preview:
      "linear-gradient(145deg, rgba(11, 22, 20, 0.98), rgba(8, 14, 16, 0.96))",
    terminalStyle: {
      backgroundColor: "#0a1212",
      backgroundImage: "none",
    },
  },
  {
    id: "aurora-grid",
    name: "Aurora Grid",
    preview:
      "radial-gradient(circle at 18% 20%, rgba(116, 255, 214, 0.72), transparent 22%), radial-gradient(circle at 84% 18%, rgba(255, 192, 120, 0.56), transparent 28%), linear-gradient(155deg, rgba(8, 28, 31, 0.98), rgba(11, 20, 25, 0.92))",
    terminalStyle: {
      backgroundColor: "#091517",
      backgroundImage:
        "radial-gradient(circle at 18% 20%, rgba(108, 255, 212, 0.26), transparent 20%), radial-gradient(circle at 84% 18%, rgba(255, 184, 114, 0.24), transparent 28%), linear-gradient(150deg, rgba(9, 28, 31, 0.9), rgba(8, 19, 23, 0.68))",
      backgroundBlendMode: "screen, screen, normal",
    },
  },
  {
    id: "sunset-ridge",
    name: "Sunset Ridge",
    preview:
      "radial-gradient(circle at 76% 18%, rgba(255, 160, 122, 0.8), transparent 24%), radial-gradient(circle at 18% 78%, rgba(119, 164, 255, 0.42), transparent 28%), linear-gradient(160deg, rgba(45, 25, 33, 0.96), rgba(18, 28, 47, 0.94))",
    terminalStyle: {
      backgroundColor: "#11151f",
      backgroundImage:
        "radial-gradient(circle at 76% 18%, rgba(255, 150, 122, 0.28), transparent 22%), radial-gradient(circle at 18% 78%, rgba(112, 158, 255, 0.2), transparent 24%), linear-gradient(180deg, rgba(255, 164, 112, 0.14), transparent 30%), linear-gradient(160deg, rgba(45, 26, 34, 0.84), rgba(19, 29, 47, 0.74))",
      backgroundBlendMode: "screen, screen, screen, normal",
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    preview:
      "linear-gradient(135deg, rgba(22, 52, 87, 0.96), rgba(8, 22, 42, 0.98))",
    terminalStyle: {
      backgroundColor: "#08172a",
      backgroundImage:
        "repeating-linear-gradient(to right, rgba(123, 179, 255, 0.16) 0, rgba(123, 179, 255, 0.16) 1px, transparent 1px, transparent 28px), repeating-linear-gradient(to bottom, rgba(123, 179, 255, 0.12) 0, rgba(123, 179, 255, 0.12) 1px, transparent 1px, transparent 28px), radial-gradient(circle at 18% 22%, rgba(139, 197, 255, 0.2), transparent 26%), linear-gradient(145deg, rgba(13, 36, 64, 0.84), rgba(6, 18, 36, 0.76))",
      backgroundBlendMode: "normal, normal, screen, normal",
    },
  },
  {
    id: "forest-haze",
    name: "Forest Haze",
    preview:
      "radial-gradient(circle at 72% 78%, rgba(107, 247, 190, 0.54), transparent 24%), radial-gradient(circle at 14% 14%, rgba(145, 255, 213, 0.32), transparent 22%), linear-gradient(155deg, rgba(8, 36, 31, 0.98), rgba(5, 20, 18, 0.96))",
    terminalStyle: {
      backgroundColor: "#091915",
      backgroundImage:
        "radial-gradient(circle at 72% 78%, rgba(107, 247, 190, 0.2), transparent 22%), radial-gradient(circle at 14% 14%, rgba(145, 255, 213, 0.18), transparent 20%), linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 24%), linear-gradient(155deg, rgba(7, 32, 28, 0.86), rgba(5, 18, 17, 0.76))",
      backgroundBlendMode: "screen, screen, screen, normal",
    },
  },
];

const WALLPAPER_PRESET_MAP = new Map(WALLPAPER_PRESETS.map((preset) => [preset.id, preset]));

export const DEFAULT_WALLPAPER = Object.freeze({
  type: "preset",
  id: "aurora-grid",
  glass: true,
});

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
  maxContextTokens: 100000,
  approvalMode: "require_approval",
};

export const getWallpaperPreset = (id) => WALLPAPER_PRESET_MAP.get(id) || WALLPAPER_PRESET_MAP.get(DEFAULT_WALLPAPER.id);

export const normalizeWallpaperSelection = (value) => {
  const glass = value?.glass !== false;

  if (value?.type === "custom" && typeof value.dataUrl === "string" && value.dataUrl.startsWith("data:image/")) {
    return {
      type: "custom",
      name: (value.name || "Custom Wallpaper").trim() || "Custom Wallpaper",
      dataUrl: value.dataUrl,
      glass,
    };
  }

  if (value?.type === "preset" && typeof value.id === "string" && WALLPAPER_PRESET_MAP.has(value.id)) {
    return {
      type: "preset",
      id: value.id,
      glass,
    };
  }

  return { ...DEFAULT_WALLPAPER };
};

export const getWallpaperLabel = (selection) => {
  const normalized = normalizeWallpaperSelection(selection);
  if (normalized.type === "custom") {
    return normalized.name;
  }
  return getWallpaperPreset(normalized.id).name;
};

export const getWallpaperPreviewStyle = (selection) => {
  const normalized = normalizeWallpaperSelection(selection);
  if (normalized.type === "custom") {
    return {
      backgroundImage: `linear-gradient(180deg, rgba(2, 6, 8, 0.24), rgba(2, 6, 8, 0.5)), url(${normalized.dataUrl})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundBlendMode: "multiply, normal",
      backgroundColor: "#081214",
    };
  }

  const preset = getWallpaperPreset(normalized.id);
  return {
    backgroundImage: preset.preview,
    backgroundColor: preset.terminalStyle.backgroundColor,
  };
};

export const getTerminalWallpaperStyle = (selection) => {
  const normalized = normalizeWallpaperSelection(selection);
  if (normalized.type === "custom") {
    return {
      backgroundColor: "#081214",
      backgroundImage: `linear-gradient(180deg, rgba(4, 8, 10, 0.14), rgba(0, 0, 0, 0.48)), url(${normalized.dataUrl})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundBlendMode: "multiply, normal",
    };
  }

  const preset = getWallpaperPreset(normalized.id);
  return {
    backgroundColor: preset.terminalStyle.backgroundColor,
    backgroundImage: preset.terminalStyle.backgroundImage,
    backgroundBlendMode: preset.terminalStyle.backgroundBlendMode,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  };
};
