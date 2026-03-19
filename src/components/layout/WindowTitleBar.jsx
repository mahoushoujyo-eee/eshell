import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bot, Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

function WindowControlButton({ title, onClick, tone = "normal", children }) {
  return (
    <button
      type="button"
      title={title}
      className={[
        "inline-flex h-7 w-9 items-center justify-center border border-border text-muted transition-colors",
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

function AiEntryButton({ active, busy, onClick }) {
  return (
    <button
      type="button"
      title={active ? "Hide AI chat" : "Show AI chat"}
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
  const appWindow = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

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

  return (
    <header className="flex h-9 shrink-0 items-center border-b border-border bg-surface/95 px-2">
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm text-muted select-none"
      >
        <span className="text-[11px] font-semibold tracking-[0.2em] uppercase">eShell</span>
        <span className="truncate text-xs opacity-85">Operations Console</span>
      </div>

      <div className="ml-3 flex items-center gap-2">
        <AiEntryButton active={showAiPanel} busy={isAiStreaming} onClick={onToggleAiPanel} />
      </div>

      <div className="ml-2 flex items-center gap-px">
        <WindowControlButton
          title="Minimize"
          onClick={() => safeWindowAction(() => appWindow.minimize(), "minimize")}
        >
          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        </WindowControlButton>

        <WindowControlButton title={isMaximized ? "Restore" : "Maximize"} onClick={handleToggleMaximize}>
          {isMaximized ? (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </WindowControlButton>

        <WindowControlButton
          title="Close"
          tone="danger"
          onClick={() => safeWindowAction(() => appWindow.close(), "close")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </WindowControlButton>
      </div>
    </header>
  );
}
