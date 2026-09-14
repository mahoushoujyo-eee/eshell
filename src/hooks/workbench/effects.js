import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { normalizeWallpaperSelection } from "../../constants/workbench";
import { normalizeSftpTransferEvent, upsertSftpTransfer } from "../../lib/sftp-transfer";
import { api } from "../../lib/tauri-api";

const sftpRemoteParentDir = (path) => {
  if (!path || path === "/") return "/";
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = p.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : p.substring(0, lastSlash);
};

export function useWorkbenchEffects({
  theme,
  wallpaper,
  downloadDirectory,
  bootstrap,
  activeSessionId,
  disconnectedSessions,
  markSessionDisconnected,
  onError,
  setSftpTransfers,
  setSftpEntries,
  setSelectedEntry,
  setOpenFilePath,
  openFileSessionId,
  setOpenFileSessionId,
  setOpenFileContent,
  setDirtyFile,
  currentPath,
  refreshSftp,
  showSftpPanel,
  showStatusPanel,
  refreshStatus,
  currentNic,
  saveTimerRef,
  openFilePath,
  dirtyFile,
  runBusy,
  runWithSessionReconnect,
  openFileContent,
  setKiPrompt,
  statusRefreshInterval,
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
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("eshell:sftp-download-dir", downloadDirectory || "");
  }, [downloadDirectory]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen("sftp-transfer", (event) => {
      const normalized = normalizeSftpTransferEvent(event.payload);
      if (!normalized) {
        return;
      }
      setSftpTransfers((prev) => upsertSftpTransfer(prev, normalized));

      if (
        normalized.stage === "completed" &&
        normalized.direction === "upload" &&
        normalized.sessionId === activeSessionId &&
        showSftpPanel &&
        normalized.remotePath
      ) {
        const remoteParent = sftpRemoteParentDir(normalized.remotePath);
        if (remoteParent === currentPath || normalized.remotePath === currentPath) {
          void refreshSftp(currentPath);
        }
      }
    }).catch((error) => {
      if (!disposed) {
        console.warn("Failed to bind sftp-transfer listener", error);
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
  }, [activeSessionId, currentPath, refreshSftp, setSftpTransfers, showSftpPanel]);

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

  useEffect(() => {
    if (!activeSessionId) {
      setOpenFilePath("");
      setOpenFileSessionId(null);
      setOpenFileContent("");
      setDirtyFile(false);
      return undefined;
    }

    void refreshSftp(currentPath);
    return undefined;
  }, [
    activeSessionId,
    currentPath,
    refreshSftp,
    setDirtyFile,
    setOpenFileContent,
    setOpenFilePath,
    setOpenFileSessionId,
  ]);

  // Switching tabs must not carry the previous tab's directory listing or
  // selection over: the toolbar acts on `selectedEntry`, so a stale selection
  // would delete or download a path on whichever server is now in front. The
  // listing for the tab being switched to is refetched by the effect above.
  useEffect(() => {
    setSftpEntries([]);
    setSelectedEntry(null);
  }, [activeSessionId, setSelectedEntry, setSftpEntries]);

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

  useEffect(() => {
    if (!activeSessionId) {
      return undefined;
    }

    const shouldPollStatus = showSftpPanel || showStatusPanel;
    if (!shouldPollStatus) {
      return undefined;
    }
    // A disconnected session has no backend state to poll; resume after reconnect.
    if (disconnectedSessions[activeSessionId]) {
      return undefined;
    }

    void refreshStatus(activeSessionId, currentNic);
    const interval = typeof statusRefreshInterval === "number" && statusRefreshInterval >= 1000
      ? statusRefreshInterval
      : 5000;
    const timer = setInterval(() => {
      void refreshStatus(activeSessionId, currentNic);
    }, interval);
    return () => clearInterval(timer);
  }, [
    activeSessionId,
    currentNic,
    disconnectedSessions,
    refreshStatus,
    showSftpPanel,
    showStatusPanel,
    statusRefreshInterval,
  ]);

  useEffect(() => {
    if (!openFileSessionId || !openFilePath || !dirtyFile) {
      return undefined;
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(async () => {
      try {
        await runBusy("Save edited file", () =>
          // Target the session the file was opened from, not the active tab.
          runWithSessionReconnect(openFileSessionId, (sessionId) =>
            // Save with debounce to avoid writing on each keystroke.
            api.sftpWriteFile(sessionId, openFilePath, openFileContent),
          ),
        );
        setDirtyFile(false);
      } catch (err) {
        onError(err);
      }
    }, 700);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    dirtyFile,
    onError,
    openFileContent,
    openFilePath,
    openFileSessionId,
    runBusy,
    runWithSessionReconnect,
    saveTimerRef,
    setDirtyFile,
  ]);
}
