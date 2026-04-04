import { useCallback, useEffect, useState } from "react";
import SplitPane from "../SplitPane";
import { normalizeRemotePath } from "../../utils/path";
import SftpDeleteConfirmDialog from "./sftp/SftpDeleteConfirmDialog";
import SftpEntriesPane from "./sftp/SftpEntriesPane";
import SftpEntryContextMenu from "./sftp/SftpEntryContextMenu";
import SftpTextOpenConfirmDialog from "./sftp/SftpTextOpenConfirmDialog";
import SftpToolbar from "./sftp/SftpToolbar";
import SftpTransferQueue from "./sftp/SftpTransferQueue";
import SftpTreePane from "./sftp/SftpTreePane";
import { getSftpTextOpenGuard } from "./sftp/sftpOpenGuard";
import { getDirectoryNodes } from "./sftp/sftpPanelUtils";

export default function SftpPanel({
  activeSessionId,
  currentPath,
  requestSftpDir,
  refreshSftp,
  uploadFile,
  downloadFile,
  deleteSftpEntry,
  cancelTransfer,
  downloadDirectory,
  onDownloadDirectoryChange,
  transfers,
  selectedEntry,
  sftpEntries,
  openEntry,
  selectSftpEntry,
  onOpenFileEditor,
  formatBytes,
}) {
  const [treeNodesByPath, setTreeNodesByPath] = useState({});
  const [expandedPaths, setExpandedPaths] = useState({ "/": true });
  const [loadingPaths, setLoadingPaths] = useState({});
  const [selectedTreePath, setSelectedTreePath] = useState("/");
  const [showTransferPanel, setShowTransferPanel] = useState(false);
  const [pendingTextOpen, setPendingTextOpen] = useState(null);
  const [confirmOpenBusy, setConfirmOpenBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState(null);
  const [confirmDeleteBusy, setConfirmDeleteBusy] = useState(false);

  const cacheNodeChildren = useCallback((targetPath, entries) => {
    const normalized = normalizeRemotePath(targetPath);
    setTreeNodesByPath((prev) => ({
      ...prev,
      [normalized]: getDirectoryNodes(entries),
    }));
  }, []);

  const loadTreeNode = useCallback(
    async (targetPath) => {
      if (!activeSessionId) {
        return null;
      }
      const normalized = normalizeRemotePath(targetPath);
      setLoadingPaths((prev) => ({ ...prev, [normalized]: true }));
      const result = await requestSftpDir(normalized);
      setLoadingPaths((prev) => ({ ...prev, [normalized]: false }));
      if (!result) {
        return null;
      }

      const resolvedPath = normalizeRemotePath(result.path || normalized);
      cacheNodeChildren(resolvedPath, result.entries);
      if (resolvedPath !== normalized) {
        cacheNodeChildren(normalized, result.entries);
      }
      return {
        ...result,
        path: resolvedPath,
      };
    },
    [activeSessionId, cacheNodeChildren, requestSftpDir],
  );

  useEffect(() => {
    setTreeNodesByPath({});
    setExpandedPaths({ "/": true });
    setLoadingPaths({});

    if (!activeSessionId) {
      setSelectedTreePath("/");
      return;
    }
    setSelectedTreePath("/");
    void loadTreeNode("/");
  }, [activeSessionId, loadTreeNode]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    setSelectedTreePath(normalizeRemotePath(currentPath || "/"));
  }, [activeSessionId, currentPath]);

  useEffect(() => {
    setPendingTextOpen(null);
    setConfirmOpenBusy(false);
    setContextMenu(null);
    setPendingDeleteEntry(null);
    setConfirmDeleteBusy(false);
  }, [activeSessionId]);

  const performOpenSftpEntry = async (entry) => {
    const result = await openEntry(entry);
    if (result?.opened) {
      onOpenFileEditor?.();
    }
  };

  const openSftpEntry = async (entry) => {
    if (!entry) {
      return;
    }

    selectSftpEntry?.(entry);

    if (entry.entryType === "directory") {
      await performOpenSftpEntry(entry);
      return;
    }

    const guard = getSftpTextOpenGuard(entry);
    if (guard) {
      setPendingTextOpen({ entry, guard });
      return;
    }

    await performOpenSftpEntry(entry);
  };

  const openEntryContextMenu = (entry, event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!entry || entry.entryType === "directory") {
      setContextMenu(null);
      return;
    }
    selectSftpEntry?.(entry);
    setContextMenu({
      entry,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const closeEntryContextMenu = () => {
    setContextMenu(null);
  };

  const confirmTextOpen = async () => {
    if (!pendingTextOpen?.entry) {
      return;
    }

    setConfirmOpenBusy(true);
    try {
      await performOpenSftpEntry(pendingTextOpen.entry);
      setPendingTextOpen(null);
    } finally {
      setConfirmOpenBusy(false);
    }
  };

  const requestDeleteEntry = (entry) => {
    if (!entry || entry.entryType === "directory") {
      return;
    }
    closeEntryContextMenu();
    setPendingDeleteEntry(entry);
  };

  const confirmDeleteEntry = async () => {
    if (!pendingDeleteEntry) {
      return;
    }

    setConfirmDeleteBusy(true);
    try {
      const deleted = await deleteSftpEntry(pendingDeleteEntry);
      if (deleted) {
        setPendingDeleteEntry(null);
      }
    } finally {
      setConfirmDeleteBusy(false);
    }
  };

  const transferRows = Array.isArray(transfers) ? transfers.slice(0, 8) : [];
  const activeTransferCount = transferRows.filter((item) =>
    item && ["queued", "started", "progress"].includes(item.stage),
  ).length;

  const configureDownloadDirectory = () => {
    if (typeof onDownloadDirectoryChange !== "function" || typeof window === "undefined") {
      return;
    }

    const current = typeof downloadDirectory === "string" ? downloadDirectory : "";
    const next = window.prompt("Set local download directory", current);
    if (next === null) {
      return;
    }
    onDownloadDirectoryChange(next);
  };

  const toggleNode = async (nodePath) => {
    const normalized = normalizeRemotePath(nodePath);
    const expanded = Boolean(expandedPaths[normalized]);

    if (expanded) {
      setExpandedPaths((prev) => ({ ...prev, [normalized]: false }));
      return;
    }

    setExpandedPaths((prev) => ({ ...prev, [normalized]: true }));
    if (!treeNodesByPath[normalized] && !loadingPaths[normalized]) {
      await loadTreeNode(normalized);
    }
  };

  const selectDirectory = async (nodePath) => {
    const normalized = normalizeRemotePath(nodePath);
    setSelectedTreePath(normalized);
    setExpandedPaths((prev) => ({ ...prev, [normalized]: true }));

    const result = await refreshSftp(normalized);
    if (!result) {
      return;
    }

    const resolvedPath = normalizeRemotePath(result.path || normalized);
    cacheNodeChildren(resolvedPath, result.entries);
    if (resolvedPath !== normalized) {
      cacheNodeChildren(normalized, result.entries);
    }
    setSelectedTreePath(resolvedPath);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-panel">
      <SftpToolbar
        activeSessionId={activeSessionId}
        currentPath={currentPath}
        refreshSftp={refreshSftp}
        configureDownloadDirectory={configureDownloadDirectory}
        downloadDirectory={downloadDirectory}
        uploadFile={uploadFile}
        downloadFile={downloadFile}
        selectedEntry={selectedEntry}
        showTransferPanel={showTransferPanel}
        onToggleTransferPanel={() => setShowTransferPanel((prev) => !prev)}
        activeTransferCount={activeTransferCount}
      />

      <div className="min-h-0 flex-1">
        <SplitPane
          direction="horizontal"
          initialRatio={0.33}
          minPrimarySize={150}
          minSecondarySize={220}
          primary={
            <SftpTreePane
              activeSessionId={activeSessionId}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              selectedTreePath={selectedTreePath}
              treeNodesByPath={treeNodesByPath}
              onToggleNode={toggleNode}
              onSelectDirectory={selectDirectory}
              onReloadRoot={() => loadTreeNode("/")}
            />
          }
          secondary={
            <SftpEntriesPane
              currentPath={currentPath}
              sftpEntries={sftpEntries}
              selectedEntry={selectedEntry}
              selectSftpEntry={selectSftpEntry}
              openSftpEntry={openSftpEntry}
              openEntryContextMenu={openEntryContextMenu}
              formatBytes={formatBytes}
            />
          }
        />
      </div>

      <SftpTransferQueue
        open={showTransferPanel}
        transferRows={transferRows}
        downloadDirectory={downloadDirectory}
        onConfigureDownloadDirectory={configureDownloadDirectory}
        cancelTransfer={cancelTransfer}
        formatBytes={formatBytes}
        onClose={() => setShowTransferPanel(false)}
      />

      <SftpEntryContextMenu
        open={Boolean(contextMenu)}
        position={contextMenu}
        entry={contextMenu?.entry || null}
        onClose={closeEntryContextMenu}
        onOpen={async (entry) => {
          closeEntryContextMenu();
          await openSftpEntry(entry);
        }}
        onDownload={async (entry) => {
          closeEntryContextMenu();
          await downloadFile(entry);
        }}
        onDelete={requestDeleteEntry}
      />

      <SftpTextOpenConfirmDialog
        open={Boolean(pendingTextOpen)}
        entry={pendingTextOpen?.entry || null}
        guard={pendingTextOpen?.guard || null}
        busy={confirmOpenBusy}
        formatBytes={formatBytes}
        onCancel={() => {
          if (confirmOpenBusy) {
            return;
          }
          setPendingTextOpen(null);
        }}
        onConfirm={confirmTextOpen}
      />

      <SftpDeleteConfirmDialog
        open={Boolean(pendingDeleteEntry)}
        entry={pendingDeleteEntry}
        busy={confirmDeleteBusy}
        onCancel={() => {
          if (confirmDeleteBusy) {
            return;
          }
          setPendingDeleteEntry(null);
        }}
        onConfirm={confirmDeleteEntry}
      />
    </div>
  );
}
