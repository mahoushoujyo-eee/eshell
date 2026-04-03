import { File, FileQuestion, Folder, Link2 } from "lucide-react";

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

export default function SftpEntriesPane({
  currentPath,
  sftpEntries,
  selectedEntry,
  openSftpEntry,
  formatBytes,
}) {
  return (
    <div className="h-full overflow-hidden text-xs">
      <div className="border-b border-border bg-surface/40 px-2 py-1 text-muted">Path: {currentPath}</div>

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
  );
}
