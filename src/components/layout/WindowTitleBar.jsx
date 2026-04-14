import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bot, Copy, Minus, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";

const TITLEBAR_PLATFORM_OVERRIDE_KEY = "eshell:debug:titlebar-platform";
const TITLEBAR_PLATFORM_OVERRIDE_EVENT = "eshell:titlebar-platform-override-change";

function normalizePlatformKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "macos" || normalized === "windows" || normalized === "linux") {
    return normalized;
  }
  return "auto";
}

function detectDesktopPlatform() {
  if (typeof window === "undefined") {
    return "unknown";
  }

  const source =
    window.navigator?.userAgentData?.platform ||
    window.navigator?.platform ||
    window.navigator?.userAgent ||
    "";
  const normalized = String(source).toLowerCase();

  if (normalized.includes("mac")) {
    return "macos";
  }
  if (normalized.includes("win")) {
    return "windows";
  }
  if (normalized.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

function readPlatformOverride() {
  if (typeof window === "undefined") {
    return "auto";
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = normalizePlatformKind(params.get("titlebarPlatform"));
    if (fromQuery !== "auto") {
      return fromQuery;
    }
  } catch {
    // noop
  }

  try {
    return normalizePlatformKind(window.localStorage.getItem(TITLEBAR_PLATFORM_OVERRIDE_KEY));
  } catch {
    return "auto";
  }
}

function resolveDesktopPlatform() {
  const override = readPlatformOverride();
  return override === "auto" ? detectDesktopPlatform() : override;
}

function setPlatformOverride(nextValue) {
  if (typeof window === "undefined") {
    return "auto";
  }

  const normalized = normalizePlatformKind(nextValue);
  try {
    if (normalized === "auto") {
      window.localStorage.removeItem(TITLEBAR_PLATFORM_OVERRIDE_KEY);
    } else {
      window.localStorage.setItem(TITLEBAR_PLATFORM_OVERRIDE_KEY, normalized);
    }
  } catch {
    // noop
  }

  window.dispatchEvent(
    new CustomEvent(TITLEBAR_PLATFORM_OVERRIDE_EVENT, {
      detail: { override: normalized },
    }),
  );
  return normalized;
}

function WindowControlButton({ title, onClick, tone = "normal", children }) {
  return (
    <button
      type="button"
      title={title}
      className={[
        "inline-flex h-7 w-9 items-center justify-center rounded-lg border border-border bg-panel/80 text-muted transition-colors",
        tone === "danger"
          ? "hover:border-danger/70 hover:bg-danger/10 hover:text-danger"
          : "hover:border-accent/40 hover:bg-accent-soft hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MacWindowControlButton({ title, tone = "danger", onClick, children }) {
  const toneClass =
    tone === "danger"
      ? "border-[#e2483f]/80 bg-[#ff5f57] text-black/65"
      : tone === "warning"
        ? "border-[#d7a52b]/80 bg-[#febc2e] text-black/60"
        : "border-[#1ea833]/80 bg-[#28c840] text-black/55";

  return (
    <button
      type="button"
      title={title}
      className={[
        "group inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-transform hover:scale-105",
        toneClass,
      ].join(" ")}
      onClick={onClick}
    >
      <span className="opacity-0 transition-opacity group-hover:opacity-70">{children}</span>
    </button>
  );
}

function AiEntryButton({ active, busy, onClick }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      title={active ? t("Hide AI chat") : t("Show AI chat")}
      className={[
        "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-all",
        active
          ? "border-accent/60 bg-accent-soft text-text shadow-[0_12px_30px_rgba(16,24,32,0.2)]"
          : "border-border/90 bg-panel/85 text-muted hover:border-accent/40 hover:bg-accent-soft hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <span
        className={[
          "relative inline-flex h-5 w-5 items-center justify-center rounded-full border",
          active ? "border-accent/55 bg-accent text-white" : "border-border bg-surface text-accent",
        ].join(" ")}
      >
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? (
          <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-panel bg-success" />
        ) : null}
      </span>
      <span className="leading-none">eShell AI</span>
    </button>
  );
}

export default function WindowTitleBar({ showAiPanel, onToggleAiPanel, isAiStreaming = false }) {
  const { t } = useI18n();
  const appWindow = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);
  const [detectedPlatform, setDetectedPlatform] = useState(detectDesktopPlatform);
  const [platformKind, setPlatformKind] = useState(resolveDesktopPlatform);
  const titleBarRef = useRef(null);
  const isMacPlatform = platformKind === "macos";

  useEffect(() => {
    const detected = detectDesktopPlatform();
    setDetectedPlatform(detected);
    setPlatformKind(resolveDesktopPlatform());

    const handleOverrideChange = () => {
      setDetectedPlatform(detectDesktopPlatform());
      setPlatformKind(resolveDesktopPlatform());
    };

    window.addEventListener(TITLEBAR_PLATFORM_OVERRIDE_EVENT, handleOverrideChange);
    return () => window.removeEventListener(TITLEBAR_PLATFORM_OVERRIDE_EVENT, handleOverrideChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const debugApi = {
      getDetectedPlatform: () => detectDesktopPlatform(),
      getTitleBarPlatform: () => resolveDesktopPlatform(),
      getTitleBarPlatformOverride: () => readPlatformOverride(),
      setTitleBarPlatform: (nextValue = "auto") => setPlatformOverride(nextValue),
      clearTitleBarPlatformOverride: () => setPlatformOverride("auto"),
      help: () => ({
        detected: detectDesktopPlatform(),
        effective: resolveDesktopPlatform(),
        override: readPlatformOverride(),
        usage: [
          'window.__eshellDebug.setTitleBarPlatform("macos")',
          'window.__eshellDebug.setTitleBarPlatform("windows")',
          'window.__eshellDebug.setTitleBarPlatform("linux")',
          'window.__eshellDebug.clearTitleBarPlatformOverride()',
        ],
      }),
    };

    window.__eshellDebug = {
      ...(window.__eshellDebug || {}),
      ...debugApi,
    };

    return () => {
      if (!window.__eshellDebug) {
        return;
      }
      delete window.__eshellDebug.getDetectedPlatform;
      delete window.__eshellDebug.getTitleBarPlatform;
      delete window.__eshellDebug.getTitleBarPlatformOverride;
      delete window.__eshellDebug.setTitleBarPlatform;
      delete window.__eshellDebug.clearTitleBarPlatformOverride;
      delete window.__eshellDebug.help;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten = null;

    const syncMaximized = async () => {
      try {
        const value = await appWindow.isMaximized();
        if (mounted) {
          setIsMaximized(value);
        }
      } catch {
        // noop: keep browser preview usable outside tauri runtime
      }
    };

    const bindEvents = async () => {
      try {
        await syncMaximized();
        unlisten = await appWindow.onResized(syncMaximized);
      } catch {
        // noop
      }
    };

    void bindEvents();

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const safeWindowAction = async (action, actionName) => {
    try {
      await action();
    } catch (error) {
      console.error(`window action failed: ${actionName}`, error);
    }
  };

  const handleToggleMaximize = () =>
    safeWindowAction(async () => {
      const maximized = await appWindow.isMaximized();
      if (maximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      setIsMaximized(await appWindow.isMaximized());
    }, "toggle-maximize");

  useEffect(() => {
    const titleBarElement = titleBarRef.current;
    if (!titleBarElement) {
      return undefined;
    }

    const handleMouseDown = (event) => {
      if (event.button !== 0) {
        return;
      }

      const targetElement = event.target instanceof Element ? event.target : null;
      if (
        targetElement?.closest(
          "button, a, input, textarea, select, [role='button'], [data-window-control], [data-tauri-no-drag]",
        )
      ) {
        return;
      }

      if (event.detail === 2) {
        void handleToggleMaximize();
        return;
      }

      appWindow.startDragging().catch((error) => {
        console.error("window action failed: start-dragging", error);
      });
    };

    titleBarElement.addEventListener("mousedown", handleMouseDown);
    return () => titleBarElement.removeEventListener("mousedown", handleMouseDown);
  }, [appWindow, handleToggleMaximize]);

  const titleContent = (
    <div
      data-tauri-drag-region
      className={[
        "flex min-w-0 items-center gap-2 px-1 text-sm text-muted select-none",
        isMacPlatform ? "mx-auto max-w-[48%] justify-center text-center" : "flex-1",
      ].join(" ")}
    >
      <span data-tauri-drag-region className="text-[11px] font-semibold tracking-[0.2em] uppercase">
        eShell
      </span>
      <span data-tauri-drag-region className="truncate text-xs opacity-85">
        {t("Operations Console")}
      </span>
    </div>
  );

  return (
    <header
      ref={titleBarRef}
      data-tauri-drag-region
      className={[
        "relative shrink-0 border-b border-border bg-surface/95",
        isMacPlatform ? "flex h-10 items-center px-3" : "flex h-9 items-center px-2",
      ].join(" ")}
    >
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-1" />

      {isMacPlatform ? (
        <>
          <div
            data-window-control
            className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 items-center gap-2"
          >
            <MacWindowControlButton
              title={t("Close")}
              tone="danger"
              onClick={() => safeWindowAction(() => appWindow.close(), "close")}
            >
              <X className="h-2.5 w-2.5" aria-hidden="true" />
            </MacWindowControlButton>

            <MacWindowControlButton
              title={t("Minimize")}
              tone="warning"
              onClick={() => safeWindowAction(() => appWindow.minimize(), "minimize")}
            >
              <Minus className="h-2.5 w-2.5" aria-hidden="true" />
            </MacWindowControlButton>

            <MacWindowControlButton
              title={isMaximized ? t("Restore") : t("Maximize")}
              tone="success"
              onClick={handleToggleMaximize}
            >
              {isMaximized ? (
                <Copy className="h-2.5 w-2.5" aria-hidden="true" />
              ) : (
                <Plus className="h-2.5 w-2.5" aria-hidden="true" />
              )}
            </MacWindowControlButton>
          </div>

          {titleContent}

          <div
            data-window-control
            className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 items-center"
          >
            <AiEntryButton active={showAiPanel} busy={isAiStreaming} onClick={onToggleAiPanel} />
          </div>
        </>
      ) : (
        <>
          {titleContent}

          <div data-window-control className="ml-3 flex items-center gap-2">
            <AiEntryButton active={showAiPanel} busy={isAiStreaming} onClick={onToggleAiPanel} />
          </div>

          <div data-window-control className="ml-2 flex items-center gap-1">
            <WindowControlButton
              title={t("Minimize")}
              onClick={() => safeWindowAction(() => appWindow.minimize(), "minimize")}
            >
              <Minus className="h-3.5 w-3.5" aria-hidden="true" />
            </WindowControlButton>

            <WindowControlButton
              title={isMaximized ? t("Restore") : t("Maximize")}
              onClick={handleToggleMaximize}
            >
              {isMaximized ? (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </WindowControlButton>

            <WindowControlButton
              title={t("Close")}
              tone="danger"
              onClick={() => safeWindowAction(() => appWindow.close(), "close")}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </WindowControlButton>
          </div>
        </>
      )}
    </header>
  );
}
