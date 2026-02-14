import {
  ChevronRight,
  Download,
  File,
  FileQuestion,
  Folder,
  FolderOpen,
  Link2,
  RefreshCw,
  Upload,
} from "lucide-react";
import SplitPane from "../SplitPane";

export default function SftpPanel({
  activeSessionId,
  currentPath,
  refreshSftp,
  uploadFile,
  downloadFile,
  selectedEntry,
  segments,
  sftpEntries,
  openEntry,
  onOpenFileEditor,
  formatBytes,
}) {
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

  return (
    <div className="h-full rounded-xl border border-border/90 bg-panel p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <FolderOpen className="h-4 w-4 text-accent" aria-hidden="true" />
          SFTP Browser
        </div>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
            onClick={() => refreshSftp(currentPath)}
            disabled={!activeSessionId}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </button>
          <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 transition-colors hover:bg-accent-soft">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload
            <input type="file" className="hidden" onChange={uploadFile} disabled={!activeSessionId} />
          </label>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 transition-colors hover:bg-accent-soft"
            onClick={downloadFile}
            disabled={!activeSessionId || !selectedEntry || selectedEntry.entryType === "directory"}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </button>
        </div>
      </div>

      <SplitPane
        direction="horizontal"
        initialRatio={0.33}
        minPrimarySize={150}
        minSecondarySize={220}
        primary={
          <div
            className="h-full rounded-md border border-border/80 bg-surface p-2 text-xs"
            onContextMenu={(event) => {
              event.preventDefault();
              refreshSftp(currentPath);
            }}
          >
            {segments.map((segment) => (
              <button
                key={segment.path}
                type="button"
                className="inline-flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left transition-colors hover:bg-accent-soft"
                onClick={() => refreshSftp(segment.path)}
              >
                <ChevronRight className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
                <span className="truncate">{segment.label}</span>
              </button>
            ))}
          </div>
        }
        secondary={
          <div className="h-full overflow-hidden text-xs">
            <div className="mb-1 rounded-md border border-border/80 bg-surface px-2 py-1 text-muted">
              Path: {currentPath}
            </div>
            <div className="h-[calc(100%-1.75rem)] overflow-auto rounded-md border border-border/80 bg-surface">
              {sftpEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={[
                    "flex w-full items-center justify-between border-b border-border/50 px-2 py-1.5 text-left transition-colors hover:bg-accent-soft",
                    selectedEntry?.path === entry.path ? "bg-accent-soft" : "",
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
  );
}
