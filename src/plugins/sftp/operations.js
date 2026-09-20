import { useCallback, useRef } from "react";
import { useI18n } from "../../lib/i18n";
import { createSftpTransferSeed, upsertSftpTransfer } from "../../lib/sftp-transfer";
import { copyTextToClipboard } from "../../utils/clipboard";
import { joinPath, normalizeRemotePath, renameRemoteEntryPath } from "../../utils/path";
import { toErrorMessage } from "../../hooks/workbench/errors";

const isTransferCancelledError = (err) =>
  toErrorMessage(err).toLowerCase().includes("transfer cancelled by user");

const localPathBaseName = (value) => {
  const normalized = String(value || "").replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || "upload.bin";
};

const isValidRemoteEntryName = (value) => {
  const name = String(value || "").trim();
  return Boolean(name) && name !== "." && name !== ".." && !/[\\/]/.test(name);
};

/**
 * SFTP operations, moved verbatim from `hooks/workbench/operations.js`.
 *
 * Everything here talks to the workbench through the stable API context
 * (`ctx`): sessions/activeSessionId/currentPath/downloadDirectory plus the
 * setters it owns. No SFTP logic remains in the core hook.
 *
 * Callback identity is stable: each operation reads `ctxRef.current` at call
 * time instead of closing over a context object that changes identity every
 * render. Effects that depend on these operations (the transfer listener, the
 * debounced save) therefore keep their subscriptions and timers across
 * unrelated re-renders.
 */
export function useSftpOperations(ctx) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const requestSftpDir = useCallback(async (path) => {
    const current = ctxRef.current;
    const { activeSessionId, runBusy, runWithSessionReconnect, onError } = current;
    if (!activeSessionId) {
      return null;
    }
    try {
      const normalizedPath = normalizeRemotePath(path);
      return await runBusy(tRef.current("Read directory"), () =>
        runWithSessionReconnect(activeSessionId, (sessionId) =>
          current.api.sftp.listDir(sessionId, normalizedPath),
        ),
      );
    } catch (err) {
      onError(err);
      return null;
    }
  }, []);

  const refreshSftp = useCallback(async (path) => {
    const current = ctxRef.current;
    if (!current.activeSessionId) {
      return null;
    }
    const requestedSessionId = current.activeSessionId;
    const result = await requestSftpDir(path);
    if (!result) {
      return null;
    }
    const targetSessionId =
      current.resolveSessionAlias(requestedSessionId) || requestedSessionId;
    current.setSftpEntries(result.entries);
    current.setSftpPath((prev) => ({
      ...prev,
      [targetSessionId]: normalizeRemotePath(result.path),
    }));
    current.setSelectedEntry(null);
    return result;
  }, [requestSftpDir]);

  const openEntry = useCallback(
    async (entry) => {
      const current = ctxRef.current;
      if (!current.activeSessionId) {
        return { opened: false };
      }
      current.setSelectedEntry(entry);
      if (entry.entryType === "directory") {
        await refreshSftp(entry.path);
        return { opened: false };
      }
      try {
        const opened = await current.runBusy(tRef.current("Read file"), () =>
          current.runWithSessionReconnect(current.activeSessionId, async (sessionId) => ({
            sessionId,
            file: await current.api.sftp.readFile(sessionId, entry.path),
          })),
        );
        // Remember the owning session so later saves cannot land on another tab.
        current.setOpenFileSessionId(opened.sessionId);
        current.setOpenFilePath(normalizeRemotePath(opened.file.path));
        current.setOpenFileContent(opened.file.content || "");
        current.setDirtyFile(false);
        return { opened: true, path: normalizeRemotePath(opened.file.path) };
      } catch (err) {
        current.onError(err);
        return { opened: false };
      }
    },
    [refreshSftp],
  );

  const selectSftpEntry = useCallback((entry) => {
    ctxRef.current.setSelectedEntry(entry || null);
  }, []);

  const uploadFile = useCallback(async () => {
    const current = ctxRef.current;
    if (!current.activeSessionId) {
      return;
    }
    const selectedPath = await current.api.sftp.selectUploadFile();
    const localPath = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
    if (!localPath) {
      return;
    }

    const fileName = localPathBaseName(localPath);
    const transferId =
      globalThis.crypto?.randomUUID?.() || `upload-${Date.now()}-${Math.random()}`;
    const remotePath = joinPath(current.currentPath, fileName);
    const seed = createSftpTransferSeed({
      transferId,
      sessionId: current.activeSessionId,
      direction: "upload",
      remotePath,
      localPath,
      fileName,
    });
    if (seed) {
      current.setSftpTransfers((prev) => upsertSftpTransfer(prev, seed));
    }

    try {
      await current.runBusy(tRef.current("Upload file"), () =>
        current.runWithSessionReconnect(current.activeSessionId, (sessionId) =>
          current.api.sftp.uploadLocalFile(
            sessionId,
            remotePath,
            localPath,
            transferId,
            fileName,
          ),
        ),
      );
      await refreshSftp(current.currentPath);
    } catch (err) {
      const cancelled = isTransferCancelledError(err);
      current.setSftpTransfers((prev) =>
        upsertSftpTransfer(prev, {
          transferId,
          sessionId: current.activeSessionId,
          direction: "upload",
          stage: cancelled ? "cancelled" : "failed",
          remotePath,
          localPath,
          fileName,
          transferredBytes: 0,
          totalBytes: null,
          percent: 0,
          message: cancelled ? tRef.current("Transfer cancelled") : toErrorMessage(err),
        }),
      );
      if (!cancelled) {
        current.onError(err);
      }
    }
  }, [refreshSftp]);

  const createSftpEntry = useCallback(
    async (entryType, rawName) => {
      const current = ctxRef.current;
      if (!current.activeSessionId) {
        return false;
      }
      const isDirectory = entryType === "directory";
      const name = String(rawName || "").trim();
      if (!isValidRemoteEntryName(name)) {
        current.onError(tRef.current("Use a name without slashes."));
        return false;
      }

      const remotePath = joinPath(current.currentPath, name);
      try {
        await current.runBusy(
          tRef.current(isDirectory ? "Create remote folder" : "Create remote file"),
          () =>
            current.runWithSessionReconnect(current.activeSessionId, (sessionId) =>
              isDirectory
                ? current.api.sftp.createDirectory(sessionId, remotePath)
                : current.api.sftp.createFile(sessionId, remotePath),
            ),
        );
        await refreshSftp(current.currentPath);
        current.setSelectedEntry({
          name,
          path: remotePath,
          entryType: isDirectory ? "directory" : "file",
          size: 0,
          modifiedAt: null,
        });
        current.pushUiNotice(
          tRef.current(isDirectory ? "Created folder {name}" : "Created file {name}", {
            name,
          }),
          {
            tone: "success",
            ttlMs: 4200,
          },
        );
        return true;
      } catch (err) {
        current.onError(err);
        return false;
      }
    },
    [refreshSftp],
  );

  const downloadFile = useCallback(async (entry = null) => {
    const current = ctxRef.current;
    const targetEntry = entry || current.selectedEntry;
    if (!current.activeSessionId || !targetEntry || targetEntry.entryType === "directory") {
      return;
    }
    const localDir = (current.downloadDirectory || "").trim();
    if (!localDir) {
      current.onError(tRef.current("Please set a local download directory first"));
      return;
    }

    const transferId =
      globalThis.crypto?.randomUUID?.() || `download-${Date.now()}-${Math.random()}`;
    const remotePath = normalizeRemotePath(targetEntry.path);
    const seed = createSftpTransferSeed({
      transferId,
      sessionId: current.activeSessionId,
      direction: "download",
      remotePath,
      localPath: localDir,
      fileName: targetEntry.name || "download.bin",
      totalBytes: targetEntry.size || null,
    });
    if (seed) {
      current.setSftpTransfers((prev) => upsertSftpTransfer(prev, seed));
    }

    try {
      const result = await current.runBusy(tRef.current("Download file"), () =>
        current.runWithSessionReconnect(current.activeSessionId, (sessionId) =>
          current.api.sftp.downloadToLocal(sessionId, remotePath, localDir, transferId),
        ),
      );
      current.setSftpTransfers((prev) =>
        upsertSftpTransfer(prev, {
          transferId,
          sessionId: current.activeSessionId,
          direction: "download",
          stage: "completed",
          remotePath: result.remotePath || remotePath,
          localPath: result.localPath || localDir,
          fileName: result.fileName || targetEntry.name || "download.bin",
          transferredBytes: result.size || targetEntry.size || 0,
          totalBytes: result.size || targetEntry.size || null,
          percent: 100,
          message: "",
        }),
      );
    } catch (err) {
      const cancelled = isTransferCancelledError(err);
      current.setSftpTransfers((prev) =>
        upsertSftpTransfer(prev, {
          transferId,
          sessionId: current.activeSessionId,
          direction: "download",
          stage: cancelled ? "cancelled" : "failed",
          remotePath,
          localPath: localDir,
          fileName: targetEntry.name || "download.bin",
          transferredBytes: 0,
          totalBytes: targetEntry.size || null,
          percent: 0,
          message: cancelled ? tRef.current("Transfer cancelled") : toErrorMessage(err),
        }),
      );
      if (!cancelled) {
        current.onError(err);
      }
    }
  }, []);

  const deleteSftpEntry = useCallback(
    async (entry = null) => {
      const current = ctxRef.current;
      const targetEntry = entry || current.selectedEntry;
      if (!current.activeSessionId || !targetEntry) {
        return false;
      }

      const remotePath = normalizeRemotePath(targetEntry.path);
      try {
        await current.runBusy(tRef.current("Delete remote file"), () =>
          current.runWithSessionReconnect(current.activeSessionId, (sessionId) =>
            current.api.sftp.deleteEntry(sessionId, remotePath, targetEntry.entryType),
          ),
        );

        if (
          targetEntry.entryType !== "directory" &&
          current.openFilePath &&
          current.openFileSessionId === current.activeSessionId &&
          normalizeRemotePath(current.openFilePath) === remotePath
        ) {
          current.setOpenFilePath("");
          current.setOpenFileSessionId(null);
          current.setOpenFileContent("");
          current.setDirtyFile(false);
        }

        await refreshSftp(current.currentPath);
        current.setSelectedEntry(null);
        current.pushUiNotice(
          tRef.current("Deleted {name}", { name: targetEntry.name || remotePath }),
          {
            tone: "success",
            ttlMs: 4200,
          },
        );
        return true;
      } catch (err) {
        current.onError(err);
        return false;
      }
    },
    [refreshSftp],
  );

  const renameSftpEntry = useCallback(
    async (entry = null, rawName = "") => {
      const current = ctxRef.current;
      const targetEntry = entry || current.selectedEntry;
      if (!current.activeSessionId || !targetEntry) {
        return false;
      }

      const name = String(rawName || "").trim();
      if (!isValidRemoteEntryName(name)) {
        current.onError(tRef.current("Use a name without slashes."));
        return false;
      }

      const remotePath = normalizeRemotePath(targetEntry.path);
      const nextPath = renameRemoteEntryPath(remotePath, name);
      if (!nextPath) {
        current.onError(tRef.current("Use a name without slashes."));
        return false;
      }

      try {
        await current.runBusy(tRef.current("Rename remote entry"), () =>
          current.runWithSessionReconnect(current.activeSessionId, (sessionId) =>
            current.api.sftp.renameEntry(sessionId, remotePath, name),
          ),
        );

        if (
          targetEntry.entryType !== "directory" &&
          current.openFilePath &&
          current.openFileSessionId === current.activeSessionId &&
          normalizeRemotePath(current.openFilePath) === remotePath
        ) {
          current.setOpenFilePath(nextPath);
        }

        await refreshSftp(current.currentPath);
        current.setSelectedEntry({
          ...targetEntry,
          name,
          path: nextPath,
        });
        current.pushUiNotice(tRef.current("Renamed {name}", { name }), {
          tone: "success",
          ttlMs: 4200,
        });
        return true;
      } catch (err) {
        current.onError(err);
        return false;
      }
    },
    [refreshSftp],
  );

  const copySftpEntryPath = useCallback(async (entry = null) => {
    const current = ctxRef.current;
    const targetEntry = entry || current.selectedEntry;
    const remotePath = targetEntry?.path ? normalizeRemotePath(targetEntry.path) : "";
    if (!remotePath) {
      return false;
    }

    try {
      const copied = await copyTextToClipboard(remotePath);
      if (!copied) {
        throw new Error(tRef.current("Failed to copy path"));
      }
      current.pushUiNotice(tRef.current("Copied path: {path}", { path: remotePath }), {
        tone: "success",
        ttlMs: 2800,
      });
      return true;
    } catch (err) {
      current.onError(err);
      return false;
    }
  }, []);

  const cancelSftpTransfer = useCallback(async (transferId) => {
    const current = ctxRef.current;
    if (!transferId) {
      return;
    }
    try {
      await current.api.sftp.cancelTransfer(transferId);
      current.setSftpTransfers((prev) =>
        upsertSftpTransfer(prev, {
          transferId,
          stage: "cancelled",
          message: tRef.current("Cancellation requested"),
        }),
      );
    } catch (err) {
      current.onError(err);
    }
  }, []);

  return {
    requestSftpDir,
    refreshSftp,
    openEntry,
    selectSftpEntry,
    uploadFile,
    createSftpEntry,
    downloadFile,
    deleteSftpEntry,
    renameSftpEntry,
    copySftpEntryPath,
    cancelSftpTransfer,
  };
}
