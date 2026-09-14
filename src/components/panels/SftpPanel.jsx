import { useCallback, useEffect, useState } from "react";
import SplitPane from "../SplitPane";
import { normalizeRemotePath } from "../../utils/path";
import SftpCreateEntryDialog from "./sftp/SftpCreateEntryDialog";
import SftpDeleteConfirmDialog from "./sftp/SftpDeleteConfirmDialog";
import SftpEntriesPane from "./sftp/SftpEntriesPane";
import SftpEntryContextMenu from "./sftp/SftpEntryContextMenu";
import SftpRenameEntryDialog from "./sftp/SftpRenameEntryDialog";
import SftpTextOpenConfirmDialog from "./sftp/SftpTextOpenConfirmDialog";
import SftpToolbar from "./sftp/SftpToolbar";
import SftpTransferQueue from "./sftp/SftpTransferQueue";
import SftpTreePane from "./sftp/SftpTreePane";
import { getSftpTextOpenGuard } from "./sftp/sftpOpenGuard";
import { getDirectoryNodes } from "./sftp/sftpPanelUtils";
import { api } from "../../lib/tauri-api";

export default function SftpPanel({
  activeSessionId,
  currentPath,
  requestSftpDir,
  refreshSftp,
  uploadFile,
  createSftpEntry,
  downloadFile,
  deleteSftpEntry,
  renameSftpEntry,
  copySftpEntryPath,
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
  const [pendingCreateEntryType, setPendingCreateEntryType] = useState(null);
  const [confirmCreateBusy, setConfirmCreateBusy] = useState(false);
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState(null);
  const [confirmDeleteBusy, setConfirmDeleteBusy] = useState(false);
  const [pendingRenameEntry, setPendingRenameEntry] = useState(null);
  const [confirmRenameBusy, setConfirmRenameBusy] = useState(false);

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
    setPendingCreateEntryType(null);
    setConfirmCreateBusy(false);
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

    if (!entry) {
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
    if (!entry) {
      return;
    }
    closeEntryContextMenu();
    setPendingDeleteEntry(entry);
  };

  const requestRenameEntry = (entry) => {
    if (!entry) {
      return;
    }
    closeEntryContextMenu();
    setPendingRenameEntry(entry);
  };

  const confirmRenameEntry = async (nextName) => {
    if (!pendingRenameEntry) {
      return;
    }

    setConfirmRenameBusy(true);
    try {
      const renamed = await renameSftpEntry?.(pendingRenameEntry, nextName);
      if (renamed) {
        setPendingRenameEntry(null);
      }
    } finally {
      setConfirmRenameBusy(false);
    }
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

  const requestCreateEntry = (entryType) => {
    if (!entryType) {
      return;
    }
    setPendingCreateEntryType(entryType);
  };

  // `pendingCreateEntryType` both opens the dialog and seeds its type; the type
  // actually created is whichever one the dialog reports back.
  const confirmCreateEntry = async (name, entryType) => {
    const targetType = entryType || pendingCreateEntryType;
    if (!targetType) {
      return;
    }

    setConfirmCreateBusy(true);
    try {
      const created = await createSftpEntry(targetType, name);
      if (created) {
        setPendingCreateEntryType(null);
      }
    } finally {
      setConfirmCreateBusy(false);
    }
  };

  const transferRows = Array.isArray(transfers) ? transfers.slice(0, 8) : [];
  const activeTransferCount = transferRows.filter((item) =>
    item && ["queued", "started", "progress"].includes(item.stage),
  ).length;

  const configureDownloadDirectory = async () => {
    if (typeof onDownloadDirectoryChange !== "function") {
      return;
    }

    const current = typeof downloadDirectory === "string" ? downloadDirectory : "";
    const selected = await api.sftpSelectDownloadDir(current);
    const next = Array.isArray(selected) ? selected[0] : selected;
    if (!next) {
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
        uploadFile={uploadFile}
        createSftpEntry={requestCreateEntry}
        downloadFile={downloadFile}
        selectedEntry={selectedEntry}
        showTransferPanel={showTransferPanel}
        onToggleTransferPanel={() => setShowTransferPanel((prev) => !prev)}
        activeTransferCount={activeTransferCount}
      />

      <div className="min-h-0 flex-1">
        <SplitPane
          direction="horizontal"
          initialRatio={0.26}
          minPrimarySize={136}
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
              onNodeContextMenu={(node, event) => {
                const dirEntry = {
                  path: node.path,
                  name: node.name,
                  entryType: "directory",
                  size: 0,
                  modifiedAt: null,
                };
                openEntryContextMenu(dirEntry, event);
              }}
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
        onCopyPath={async (entry) => {
          closeEntryContextMenu();
          await copySftpEntryPath(entry);
        }}
        onRename={requestRenameEntry}
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

      <SftpCreateEntryDialog
        open={Boolean(pendingCreateEntryType)}
        entryType={pendingCreateEntryType}
        currentPath={currentPath}
        busy={confirmCreateBusy}
        onCancel={() => {
          if (confirmCreateBusy) {
            return;
          }
          setPendingCreateEntryType(null);
        }}
        onConfirm={confirmCreateEntry}
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

      <SftpRenameEntryDialog
        open={Boolean(pendingRenameEntry)}
        entry={pendingRenameEntry}
        busy={confirmRenameBusy}
        onCancel={() => {
          if (confirmRenameBusy) {
            return;
          }
          setPendingRenameEntry(null);
        }}
        onConfirm={confirmRenameEntry}
      />
    </div>
  );
}
