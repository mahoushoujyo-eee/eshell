import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderCog,
  File,
  FileQuestion,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import SplitPane from "../SplitPane";
import { normalizeRemotePath } from "../../utils/path";

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

  const getDirectoryNodes = useCallback((entries) => {
    const deduped = new Map();
    for (const entry of entries || []) {
      if (entry.entryType !== "directory") {
        continue;
      }
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const normalized = normalizeRemotePath(entry.path);
      if (!deduped.has(normalized)) {
        deduped.set(normalized, {
          name: entry.name,
          path: normalized,
        });
      }
    }

    return [...deduped.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
  }, []);

  const cacheNodeChildren = useCallback(
    (targetPath, entries) => {
      const normalized = normalizeRemotePath(targetPath);
      setTreeNodesByPath((prev) => ({
        ...prev,
        [normalized]: getDirectoryNodes(entries),
      }));
    },
    [getDirectoryNodes],
  );

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

  const renderEntryIcon = (entryType) => {
    switch (entryType) {
      case "directory":
        return <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />;
      case "symlink":
        return <Link2 className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-hidden="true" />;
      case "file":
        return <File className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />;
      default:
        return <FileQuestion className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />;
    }
  };

  const openSftpEntry = async (entry) => {
    const result = await openEntry(entry);
    if (result?.opened) {
      onOpenFileEditor();
    }
  };

  const transferRows = Array.isArray(transfers) ? transfers.slice(0, 8) : [];
  const activeTransferCount = transferRows.filter((item) =>
    item && ["queued", "started", "progress"].includes(item.stage),
  ).length;

  const transferStageLabel = (stage) => {
    switch (stage) {
      case "queued":
        return "Queued";
      case "started":
      case "progress":
        return "Transferring";
      case "completed":
        return "Completed";
      case "cancelled":
        return "Cancelled";
      case "failed":
        return "Failed";
      default:
        return "Pending";
    }
  };

  const transferStageColor = (stage) => {
    switch (stage) {
      case "completed":
        return "text-success";
      case "cancelled":
        return "text-warning";
      case "failed":
        return "text-danger";
      case "queued":
        return "text-warning";
      default:
        return "text-accent";
    }
  };

  const transferDirectionLabel = (direction) =>
    direction === "upload" ? "Upload" : "Download";

  const configureDownloadDirectory = () => {
    if (typeof onDownloadDirectoryChange !== "function") {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    const current = typeof downloadDirectory === "string" ? downloadDirectory : "";
    const next = window.prompt("Set local download directory", current);
    if (next === null) {
      return;
    }
    onDownloadDirectoryChange(next);
  };

  const renderTransferIcon = (transfer) => {
    if (transfer.stage === "completed") {
      return <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />;
    }
    if (transfer.stage === "cancelled") {
      return <X className="h-3.5 w-3.5 text-warning" aria-hidden="true" />;
    }
    if (transfer.stage === "failed") {
      return <TriangleAlert className="h-3.5 w-3.5 text-danger" aria-hidden="true" />;
    }
    if (transfer.stage === "queued") {
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" aria-hidden="true" />;
    }
    if (transfer.direction === "upload") {
      return <ArrowUpToLine className="h-3.5 w-3.5 text-accent" aria-hidden="true" />;
    }
    return <ArrowDownToLine className="h-3.5 w-3.5 text-accent" aria-hidden="true" />;
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

  const renderTreeRows = (parentPath, depth = 0) => {
    const children = treeNodesByPath[parentPath] || [];

    return children
      .filter((node) => node.path !== parentPath)
      .map((node) => {
        const expanded = Boolean(expandedPaths[node.path]);
        const isLoading = Boolean(loadingPaths[node.path]);
        const isSelected = selectedTreePath === node.path;

        return (
          <div key={node.path}>
            <div
              className={[
                "flex items-center transition-colors",
                isSelected ? "bg-accent-soft/70" : "hover:bg-accent-soft/40",
              ].join(" ")}
              style={{ paddingLeft: `${Math.max(0, depth * 14)}px` }}
            >
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text"
                aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void toggleNode(node.path);
                }}
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>

              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-xs"
                onClick={() => void selectDirectory(node.path)}
                title={node.path}
              >
                {expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                )}
                <span className="truncate">{node.name}</span>
              </button>
            </div>

            {expanded ? renderTreeRows(node.path, depth + 1) : null}
          </div>
        );
      });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-panel">
      <div className="flex items-center justify-between border-b border-border px-2 py-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <FolderOpen className="h-4 w-4 text-accent" aria-hidden="true" />
          SFTP Browser
        </div>

        <div className="flex gap-1 text-xs">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
            onClick={() => refreshSftp(currentPath)}
            disabled={!activeSessionId}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </button>

          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
            onClick={configureDownloadDirectory}
            disabled={!activeSessionId}
            title={downloadDirectory || "Set local download folder"}
          >
            <FolderCog className="h-3.5 w-3.5" aria-hidden="true" />
            Path
          </button>

          <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload
            <input type="file" className="hidden" onChange={uploadFile} disabled={!activeSessionId} />
          </label>

          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
            onClick={downloadFile}
            disabled={!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory"}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </button>

          <button
            type="button"
            className={[
              "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 transition-colors",
              showTransferPanel ? "bg-accent-soft" : "hover:bg-accent-soft",
            ].join(" ")}
            onClick={() => setShowTransferPanel((prev) => !prev)}
            title="Toggle transfer queue"
          >
            <ArrowUpToLine className="h-3.5 w-3.5" aria-hidden="true" />
            Transfers
            {activeTransferCount > 0 ? (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {activeTransferCount}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <SplitPane
          direction="horizontal"
          initialRatio={0.33}
          minPrimarySize={150}
          minSecondarySize={220}
          primary={
            <div
              className="h-full overflow-auto border-r border-border bg-surface/30 p-2 text-xs"
              onContextMenu={(event) => {
                event.preventDefault();
                void loadTreeNode("/");
              }}
            >
              {!activeSessionId ? (
                <div className="px-2 py-1 text-muted">Connect SSH first</div>
              ) : (
                <>
                  <div
                    className={[
                      "mb-1 flex items-center transition-colors",
                      selectedTreePath === "/" ? "bg-accent-soft/70" : "hover:bg-accent-soft/40",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text"
                      aria-label={expandedPaths["/"] ? "Collapse root" : "Expand root"}
                      onClick={() => void toggleNode("/")}
                    >
                      {loadingPaths["/"] ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : expandedPaths["/"] ? (
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </button>

                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-xs"
                      onClick={() => void selectDirectory("/")}
                      title="/"
                    >
                      {expandedPaths["/"] ? (
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                      )}
                      <span className="truncate">/</span>
                    </button>
                  </div>

                  {expandedPaths["/"] ? renderTreeRows("/", 1) : null}
                </>
              )}
            </div>
          }
          secondary={
            <div className="h-full overflow-hidden text-xs">
              <div className="border-b border-border bg-surface/40 px-2 py-1 text-muted">
                Path: {currentPath}
              </div>

              <div className="h-[calc(100%-1.75rem)] overflow-auto bg-surface/20">
                {sftpEntries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={[
                      "flex w-full items-center justify-between border-b border-border/60 px-2 py-1.5 text-left transition-colors hover:bg-accent-soft/60",
                      selectedEntry?.path === entry.path ? "bg-accent-soft/70" : "",
                    ].join(" ")}
                    onClick={() => openSftpEntry(entry)}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {renderEntryIcon(entry.entryType)}
                      <span className="truncate">{entry.name}</span>
                    </span>

                    <span className="text-[10px] text-muted">
                      {entry.entryType === "directory" ? "-" : formatBytes(entry.size)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          }
        />
      </div>

      {showTransferPanel ? (
        <section className="absolute right-2 top-[3rem] z-20 w-[360px] max-w-[calc(100%-1rem)] rounded-lg border border-border bg-panel/95 p-2 shadow-xl backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold">
              <ArrowDownToLine className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              Transfer Queue
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 text-[10px] transition-colors hover:bg-accent-soft"
              onClick={() => setShowTransferPanel(false)}
            >
              Close
            </button>
          </div>

          <div className="mb-2 rounded-md border border-border/70 bg-surface/50 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-[10px] text-muted">
                Download Dir: {downloadDirectory || "(not set)"}
              </div>
              <button
                type="button"
                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-accent-soft"
                onClick={configureDownloadDirectory}
              >
                Change
              </button>
            </div>
          </div>

          <div className="max-h-72 overflow-auto pr-0.5">
            {transferRows.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 bg-surface/40 px-2 py-2 text-[11px] text-muted">
                No transfer tasks yet.
              </div>
            ) : (
              transferRows.map((transfer) => (
                <div
                  key={transfer.transferId}
                  className="mb-1.5 rounded-md border border-border/70 bg-panel/80 px-2 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {renderTransferIcon(transfer)}
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">{transfer.fileName}</div>
                        <div className="truncate text-[10px] text-muted">
                          {transferDirectionLabel(transfer.direction)}: {transfer.remotePath}
                        </div>
                      </div>
                    </div>
                    <span className={`text-[10px] font-medium ${transferStageColor(transfer.stage)}`}>
                      {transferStageLabel(transfer.stage)}
                    </span>
                  </div>

                  {["queued", "started", "progress"].includes(transfer.stage) ? (
                    <div className="mt-1 flex justify-end">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-accent-soft"
                        onClick={() => cancelTransfer?.(transfer.transferId)}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                        Cancel
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                      <div
                        className={`h-full transition-all ${
                          transfer.stage === "failed" ? "bg-danger" : "bg-accent"
                        }`}
                        style={{ width: `${Math.max(0, Math.min(100, transfer.percent || 0))}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
                      <span>
                        {formatBytes(transfer.transferredBytes || 0)}
                        {transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
                      </span>
                      <span>{Math.round(transfer.percent || 0)}%</span>
                    </div>
                    {transfer.localPath ? (
                      <div className="mt-1 truncate text-[10px] text-muted">
                        Local: {transfer.localPath}
                      </div>
                    ) : null}
                    {transfer.message ? (
                      <div className="mt-1 truncate text-[10px] text-danger">{transfer.message}</div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
