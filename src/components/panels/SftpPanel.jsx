import { useCallback, useEffect, useState } from "react";
import SplitPane from "../SplitPane";
import { normalizeRemotePath } from "../../utils/path";
import SftpEntriesPane from "./sftp/SftpEntriesPane";
import SftpToolbar from "./sftp/SftpToolbar";
import SftpTransferQueue from "./sftp/SftpTransferQueue";
import SftpTreePane from "./sftp/SftpTreePane";
import { getDirectoryNodes } from "./sftp/sftpPanelUtils";

export default function SftpPanel({
  activeSessionId,
  currentPath,
  requestSftpDir,
  refreshSftp,
  uploadFile,
  downloadFile,
  cancelTransfer,
  downloadDirectory,
  onDownloadDirectoryChange,
  transfers,
  selectedEntry,
  sftpEntries,
  openEntry,
  onOpenFileEditor,
  formatBytes,
}) {
  const [treeNodesByPath, setTreeNodesByPath] = useState({});
  const [expandedPaths, setExpandedPaths] = useState({ "/": true });
  const [loadingPaths, setLoadingPaths] = useState({});
  const [selectedTreePath, setSelectedTreePath] = useState("/");
  const [showTransferPanel, setShowTransferPanel] = useState(false);

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

  const openSftpEntry = async (entry) => {
    const result = await openEntry(entry);
    if (result?.opened) {
      onOpenFileEditor?.();
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
              openSftpEntry={openSftpEntry}
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
    </div>
  );
}
