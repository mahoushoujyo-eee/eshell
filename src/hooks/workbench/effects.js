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

export function useWorkbenchEffects({
  theme,
  wallpaper,
  downloadDirectory,
  bootstrap,
  aiStream,
  aiStreamRef,
  appendPtyOutput,
  activeSessionId,
  loadAiConversation,
  onError,
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
    const unlistenPromise = listen("pty-output", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") {
        return;
      }
      const sessionId = payload.sessionId;
      const chunk = payload.chunk;
      if (typeof sessionId !== "string" || typeof chunk !== "string" || !chunk) {
        return;
      }
      appendPtyOutput(sessionId, chunk);
    }).catch((error) => {
      if (!disposed) {
        console.warn("Failed to bind PTY output listener", error);
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
  }, [appendPtyOutput]);

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
          tasks.push(reloadAiPendingActions(activeSessionId || null));
        }
        void Promise.all(tasks).catch(() => {});
      }

      if (transition.errorMessage) {
        onError(transition.errorMessage);
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
    loadAiConversation,
    onError,
    reloadAiConversations,
    reloadAiPendingActions,
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
  }, [setSftpTransfers]);

  useEffect(() => {
    if (!activeAiConversationId) {
      setActiveAiConversation(null);
      return;
    }
    void loadAiConversation(activeAiConversationId).catch(onError);
  }, [activeAiConversationId, loadAiConversation, onError, setActiveAiConversation]);

  useEffect(() => {
    void reloadAiPendingActions(activeSessionId || null).catch(() => {});
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

  useEffect(() => {
    if (!activeSessionId) {
      return undefined;
    }

    const shouldPollStatus = showSftpPanel || showStatusPanel;
    if (!shouldPollStatus) {
      return undefined;
    }

    void refreshStatus(activeSessionId, currentNic);
    const timer = setInterval(() => {
      void refreshStatus(activeSessionId, currentNic);
    }, 5000);
    return () => clearInterval(timer);
  }, [
    activeSessionId,
    currentNic,
    refreshStatus,
    showSftpPanel,
    showStatusPanel,
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
