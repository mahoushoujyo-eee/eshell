import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
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

export default function WindowTitleBar() {
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

      <div className="flex items-center gap-px">
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
