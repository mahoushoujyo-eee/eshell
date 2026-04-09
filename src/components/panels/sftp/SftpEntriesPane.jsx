import { File, FileQuestion, Folder, Link2 } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

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
  selectSftpEntry,
  openSftpEntry,
  openEntryContextMenu,
  formatBytes,
}) {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col overflow-hidden text-xs">
      <div className="border-b border-border bg-surface/40 px-2 py-1">
        <div className="text-muted">{t("Path: {path}", { path: currentPath })}</div>
        <div className="mt-0.5 text-[10px] text-muted/80">
          {t("Single-click selects. Double-click opens. Right-click for actions.")}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-surface/20">
        {sftpEntries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={[
              "flex w-full items-center justify-between border-b border-border/60 px-2 py-1.5 text-left transition-colors hover:bg-accent-soft/60",
              selectedEntry?.path === entry.path ? "bg-accent-soft/70" : "",
            ].join(" ")}
            onClick={() => selectSftpEntry?.(entry)}
            onDoubleClick={() => void openSftpEntry(entry)}
            onContextMenu={(event) => openEntryContextMenu?.(entry, event)}
            title={`${entry.path}\n${t("Double-click to open")}`}
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
