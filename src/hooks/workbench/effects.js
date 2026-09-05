import { startTransition, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { normalizeWallpaperSelection } from "../../constants/workbench";
import {
  normalizeOpsAgentStreamEvent,
  reduceOpsAgentStreamEvent,
  upsertOpsAgentPendingAction,
} from "../../lib/ops-agent-stream";
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
  aiStream,
  aiStreamRef,
  activeSessionId,
  disconnectedSessions,
  markSessionDisconnected,
  loadAiConversation,
  onError,
  setAiConversationError,
  clearAiConversationError,
  reloadAiConversations,
  reloadAiPendingActions,
  setAiStream,
  setActiveAiConversationId,
  setAiPendingActions,
  setSftpTransfers,
  activeAiConversationId,
  setActiveAiConversation,
  setSftpEntries,
  setOpenFilePath,
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
    aiStreamRef.current = aiStream;
  }, [aiStream, aiStreamRef]);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen("ops-agent-stream", (event) => {
      const normalizedEvent = normalizeOpsAgentStreamEvent(event.payload);
      if (!normalizedEvent) {
        return;
      }

      const transition = reduceOpsAgentStreamEvent(aiStreamRef.current, normalizedEvent);
      aiStreamRef.current = transition.nextStream;

      startTransition(() => {
        setAiStream(transition.nextStream);
        if (transition.activateConversationId) {
          setActiveAiConversationId(transition.activateConversationId);
        }
        if (transition.pendingAction) {
          setAiPendingActions((prev) =>
            upsertOpsAgentPendingAction(prev, transition.pendingAction),
          );
        }
      });

      if (transition.reloadConversationId) {
        void loadAiConversation(transition.reloadConversationId).catch(() => {});
      }

      if (transition.reloadConversations || transition.reloadPendingActions) {
        const tasks = [];
        if (transition.reloadConversations) {
          tasks.push(reloadAiConversations());
        }
        if (transition.reloadPendingActions) {
          tasks.push(reloadAiPendingActions());
        }
        void Promise.all(tasks).catch(() => {});
      }

      if (
        normalizedEvent.conversationId &&
        (normalizedEvent.stage === "started" || normalizedEvent.stage === "completed")
      ) {
        clearAiConversationError(normalizedEvent.conversationId);
      }

      if (transition.errorMessage) {
        if (normalizedEvent.stage === "error" && normalizedEvent.conversationId) {
          setAiConversationError(normalizedEvent.conversationId, transition.errorMessage);
        } else {
          onError(transition.errorMessage);
        }
      }
    }).catch((error) => {
      if (!disposed) {
        console.warn("Failed to bind ops-agent-stream listener", error);
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
  }, [
    activeSessionId,
    aiStreamRef,
    clearAiConversationError,
    loadAiConversation,
    onError,
    reloadAiConversations,
    reloadAiPendingActions,
    setAiConversationError,
    setAiPendingActions,
    setAiStream,
    setActiveAiConversationId,
  ]);

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
    if (!activeAiConversationId) {
      setActiveAiConversation(null);
      return;
    }
    void loadAiConversation(activeAiConversationId).catch(onError);
  }, [activeAiConversationId, loadAiConversation, onError, setActiveAiConversation]);

  useEffect(() => {
    void reloadAiPendingActions().catch(() => {});
  }, [activeSessionId, reloadAiPendingActions]);

  useEffect(() => {
    if (!activeSessionId) {
      setSftpEntries([]);
      setOpenFilePath("");
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
    setSftpEntries,
  ]);

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
    if (!activeSessionId || !openFilePath || !dirtyFile) {
      return undefined;
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(async () => {
      try {
        await runBusy("Save edited file", () =>
          runWithSessionReconnect(activeSessionId, (sessionId) =>
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
    activeSessionId,
    dirtyFile,
    onError,
    openFileContent,
    openFilePath,
    runBusy,
    runWithSessionReconnect,
    saveTimerRef,
    setDirtyFile,
  ]);
}
