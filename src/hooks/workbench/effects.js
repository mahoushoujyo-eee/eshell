import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { normalizeWallpaperSelection } from "../../constants/workbench";

export function useWorkbenchEffects({
  theme,
  wallpaper,
  bootstrap,
  activeSessionId,
  markSessionDisconnected,
  currentPath,
  refreshSftp,
  resetFileEditor,
  setKiPrompt,
}) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      "eshell:terminal-wallpaper",
      JSON.stringify(normalizeWallpaperSelection(wallpaper)),
    );
  }, [wallpaper]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (typeof setKiPrompt !== "function") {
      return undefined;
    }
    let disposed = false;
    const unlistenPromise = listen("ssh-ki-prompt", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || !payload.requestId) {
        return;
      }
      setKiPrompt(payload);
    }).catch((error) => {
      if (!disposed) {
        console.warn("Failed to bind ssh-ki-prompt listener", error);
      }
      return null;
    });
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => {
        if (typeof unlisten === "function") {
          unlisten();
        }
      });
    };
  }, [setKiPrompt]);

  // Switching tabs drops the previous tab's open file; the sftp plugin
  // refetches the new tab's directory listing on its own. `refreshSftp` is
  // identity-stable in the plugin (latest-ref context), so this effect runs
  // exactly when the session or path changes — never because a transfer or
  // a poll snapshot re-rendered the workbench.
  useEffect(() => {
    if (!activeSessionId) {
      resetFileEditor();
      return undefined;
    }
    void refreshSftp(currentPath);
    return undefined;
  }, [activeSessionId, currentPath, refreshSftp, resetFileEditor]);

  // A PTY worker died (timeout, EOF, transport error): flag the session so the
  // terminal shows the reconnect overlay instead of silently freezing.
  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen("pty-closed", (event) => {
      if (disposed) {
        return;
      }
      const payload = event?.payload;
      if (!payload || typeof payload !== "object" || !payload.sessionId) {
        return;
      }
      markSessionDisconnected(payload.sessionId, payload.reason || "");
    });
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => {
        if (typeof unlisten === "function") {
          unlisten();
        }
      });
    };
  }, [markSessionDisconnected]);
}
