import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileQuestion,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
  Upload,
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
    <div className="flex h-full min-h-0 flex-col bg-panel">
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
    </div>
  );
}
