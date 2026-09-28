import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import EshellAiMark from "../ai/EshellAiMark";
// Brand mark cropped from `docs/assets/Shell.png` (cube + `$`), text removed so
// it can sit next to the wordmark without repeating "Shell".
import eshellMark from "../../assets/eshell-mark.png";
import SessionTabs from "./SessionTabs";

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

// Native-style caption buttons: full title-bar height, flat, with the
// platform's red close hover.
function WindowControlButton({ title, onClick, tone = "normal", children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={[
        "inline-flex h-10 w-[46px] items-center justify-center text-muted transition-colors duration-150",
        tone === "danger" ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-hover hover:text-text",
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
  const label = active ? t("Hide AI chat") : t("Show AI chat");

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors duration-150",
        active
          ? "border-accent/35 bg-accent-soft text-accent"
          : "border-border text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      <EshellAiMark busy={busy} className="h-4 w-4" />
      <span className="leading-none">AI</span>
    </button>
  );
}

function BrandMark() {
  return (
    <div data-tauri-drag-region className="flex shrink-0 items-center gap-2 pr-3 select-none">
      <img src={eshellMark} alt="" className="h-[18px] w-[18px] shrink-0" draggable={false} />
      <span data-tauri-drag-region className="brand-wordmark text-[13px] text-text">
        eShell
      </span>
    </div>
  );
}

export default function WindowTitleBar({
  showAiPanel,
  onToggleAiPanel,
  isAiStreaming = false,
  sessions = [],
  activeSessionId = null,
  onSelectSession,
  onCloseSession,
  disconnectedSessions = {},
  onNewSession,
}) {
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

  const tabs = (
    <SessionTabs
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={onSelectSession}
      onCloseSession={onCloseSession}
      disconnectedSessions={disconnectedSessions}
      onNewSession={onNewSession}
    />
  );

  const dragSpacer = <div data-tauri-drag-region className="h-full min-w-6 flex-1" />;

  return (
    <header
      ref={titleBarRef}
      data-tauri-drag-region
      className="relative flex h-10 shrink-0 items-center border-b border-border bg-bg"
    >
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-1" />

      {isMacPlatform ? (
        <>
          <div data-window-control className="flex shrink-0 items-center gap-2 pr-4 pl-3.5">
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

          {tabs}
          {dragSpacer}

          <div data-window-control className="flex shrink-0 items-center pr-3">
            <AiEntryButton active={showAiPanel} busy={isAiStreaming} onClick={onToggleAiPanel} />
          </div>
        </>
      ) : (
        <>
          <div data-tauri-drag-region className="flex h-full shrink-0 items-center pl-3.5">
            <BrandMark />
            <span data-tauri-drag-region className="mr-2 h-4 w-px bg-border" aria-hidden="true" />
          </div>

          {tabs}
          {dragSpacer}

          <div data-window-control className="flex shrink-0 items-center pr-2">
            <AiEntryButton active={showAiPanel} busy={isAiStreaming} onClick={onToggleAiPanel} />
          </div>

          <div data-window-control className="flex h-full shrink-0 items-stretch">
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
