import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  File,
  FileQuestion,
  Folder,
  Link2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

const formatModifiedAt = (modifiedAt) => {
  if (!modifiedAt) return "-";
  try {
    return new Date(modifiedAt * 1000).toLocaleDateString();
  } catch {
    return "-";
  }
};

const SortIcon = ({ active, asc }) => {
  if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-30" aria-hidden="true" />;
  return asc
    ? <ChevronUp className="h-3 w-3 text-accent" aria-hidden="true" />
    : <ChevronDown className="h-3 w-3 text-accent" aria-hidden="true" />;
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
  const [sortField, setSortField] = useState("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    setFilterText("");
  }, [currentPath]);

  const handleSortClick = (field) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const displayedEntries = useMemo(() => {
    let entries = Array.isArray(sftpEntries) ? sftpEntries : [];

    if (!showHidden) {
      entries = entries.filter((e) => !e.name.startsWith("."));
    }

    const keyword = filterText.trim().toLowerCase();
    if (keyword) {
      entries = entries.filter((e) => e.name.toLowerCase().includes(keyword));
    }

    return [...entries].sort((a, b) => {
      const aDir = a.entryType === "directory";
      const bDir = b.entryType === "directory";
      if (aDir !== bDir) return aDir ? -1 : 1;

      let cmp = 0;
      if (sortField === "name") {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      } else if (sortField === "size") {
        cmp = (a.size || 0) - (b.size || 0);
      } else if (sortField === "modifiedAt") {
        cmp = (a.modifiedAt || 0) - (b.modifiedAt || 0);
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [sftpEntries, showHidden, filterText, sortField, sortAsc]);

  return (
    <div className="flex h-full flex-col overflow-hidden text-xs">
      <div className="space-y-1.5 border-b border-border bg-surface/40 px-2 py-1.5">
        <div className="truncate text-muted" title={currentPath}>
          {t("Path: {path}", { path: currentPath })}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-xs placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
            placeholder={t("Filter...")}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          <button
            type="button"
            className={[
              "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 transition-colors",
              showHidden
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-muted hover:bg-accent-soft/60",
            ].join(" ")}
            onClick={() => setShowHidden((prev) => !prev)}
            title={showHidden ? t("Hide dotfiles") : t("Show dotfiles")}
          >
            {showHidden
              ? <Eye className="h-3 w-3" aria-hidden="true" />
              : <EyeOff className="h-3 w-3" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center border-b border-border bg-surface/60 px-2 py-0.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-0.5 text-left text-[10px] font-medium text-muted hover:text-foreground"
          onClick={() => handleSortClick("name")}
        >
          {t("Name")}
          <SortIcon active={sortField === "name"} asc={sortAsc} />
        </button>
        <button
          type="button"
          className="flex w-16 shrink-0 items-center justify-end gap-0.5 text-[10px] font-medium text-muted hover:text-foreground"
          onClick={() => handleSortClick("size")}
        >
          {t("Size")}
          <SortIcon active={sortField === "size"} asc={sortAsc} />
        </button>
        <button
          type="button"
          className="flex w-20 shrink-0 items-center justify-end gap-0.5 text-[10px] font-medium text-muted hover:text-foreground"
          onClick={() => handleSortClick("modifiedAt")}
        >
          {t("Modified")}
          <SortIcon active={sortField === "modifiedAt"} asc={sortAsc} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-surface/20">
        {displayedEntries.length === 0 && (
          <div className="py-8 text-center text-[10px] text-muted/50">
            {filterText.trim()
              ? t("No entries match the filter")
              : t("Empty directory")}
          </div>
        )}
        {displayedEntries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={[
              "flex w-full items-center border-b border-border/60 px-2 py-1.5 text-left transition-colors hover:bg-accent-soft/60",
              selectedEntry?.path === entry.path ? "bg-accent-soft/70" : "",
            ].join(" ")}
            onClick={() => selectSftpEntry?.(entry)}
            onDoubleClick={() => void openSftpEntry(entry)}
            onContextMenu={(event) => openEntryContextMenu?.(entry, event)}
            title={`${entry.path}\n${t("Double-click to open")}`}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {renderEntryIcon(entry.entryType)}
              <span className="truncate">{entry.name}</span>
            </span>
            <span className="w-16 shrink-0 text-right text-[10px] text-muted">
              {entry.entryType === "directory" ? "-" : formatBytes(entry.size)}
            </span>
            <span className="w-20 shrink-0 text-right text-[10px] text-muted">
              {formatModifiedAt(entry.modifiedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
