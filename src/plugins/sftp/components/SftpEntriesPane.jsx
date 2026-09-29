import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CornerLeftUp,
  Eye,
  EyeOff,
  File,
  FileQuestion,
  Folder,
  Link2,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { IconButton } from "../../../components/ui/Button";
import { inputSmClass } from "../../../components/ui/fieldClasses";
import { normalizeRemotePath, parentRemotePath } from "../../../utils/path";

const renderEntryIcon = (entryType) => {
  switch (entryType) {
    case "directory":
      return <Folder className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />;
    case "symlink":
      return <Link2 className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />;
    case "file":
      return <File className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />;
    default:
      return <FileQuestion className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />;
  }
};

const HEADER_CELL =
  "flex items-center gap-0.5 text-[11px] font-medium text-subtle transition-colors hover:text-text";

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
  activeSessionId,
  currentPath,
  sftpEntries,
  selectedEntry,
  selectSftpEntry,
  openSftpEntry,
  openEntryContextMenu,
  navigateToDirectory,
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

  // `null` at the filesystem root: there is nothing above `/` to go back to.
  const normalizedPath = normalizeRemotePath(currentPath);
  const parentPath = normalizedPath === "/" ? null : parentRemotePath(normalizedPath);
  const goToParentDirectory = () => {
    if (parentPath) {
      void navigateToDirectory?.(parentPath);
    }
  };

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
    <div className="flex h-full flex-col overflow-hidden bg-panel text-xs">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        <IconButton
          label={t("Go to parent directory")}
          size="xs"
          disabled={!activeSessionId || !parentPath}
          onClick={goToParentDirectory}
        >
          <CornerLeftUp className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={currentPath}>
          {t("Path: {path}", { path: currentPath })}
        </div>
        <div className="relative w-[42%] max-w-52 min-w-24">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <input
            className={`${inputSmClass} h-6 pl-6`}
            placeholder={t("Filter...")}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
        <IconButton
          label={showHidden ? t("Hide dotfiles") : t("Show dotfiles")}
          size="xs"
          active={showHidden}
          onClick={() => setShowHidden((prev) => !prev)}
        >
          {showHidden ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
        </IconButton>
      </div>

      <div className="flex h-6 shrink-0 items-center border-b border-border px-2.5">
        <button type="button" className={`${HEADER_CELL} flex-1 text-left`} onClick={() => handleSortClick("name")}>
          {t("Name")}
          <SortIcon active={sortField === "name"} asc={sortAsc} />
        </button>
        <button
          type="button"
          className={`${HEADER_CELL} w-16 shrink-0 justify-end`}
          onClick={() => handleSortClick("size")}
        >
          {t("Size")}
          <SortIcon active={sortField === "size"} asc={sortAsc} />
        </button>
        <button
          type="button"
          className={`${HEADER_CELL} w-24 shrink-0 justify-end`}
          onClick={() => handleSortClick("modifiedAt")}
        >
          {t("Modified")}
          <SortIcon active={sortField === "modifiedAt"} asc={sortAsc} />
        </button>
      </div>

      <div className="scroll-region min-h-0 flex-1 overflow-auto px-1 py-1">
        {displayedEntries.length === 0 && (
          <div className="py-8 text-center text-[11px] text-subtle">
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
              "flex h-[26px] w-full items-center rounded-md px-1.5 text-left transition-colors duration-100",
              selectedEntry?.path === entry.path ? "bg-accent-soft text-text" : "text-text/90 hover:bg-hover",
            ].join(" ")}
            onClick={() => selectSftpEntry?.(entry)}
            onDoubleClick={() => void openSftpEntry(entry)}
            onContextMenu={(event) => openEntryContextMenu?.(entry, event)}
            title={`${entry.path}\n${t("Double-click to open")}`}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {renderEntryIcon(entry.entryType)}
              <span className="truncate">{entry.name}</span>
            </span>
            <span className="w-16 shrink-0 text-right text-[11px] text-muted tabular-nums">
              {entry.entryType === "directory" ? "-" : formatBytes(entry.size)}
            </span>
            <span className="w-24 shrink-0 text-right text-[11px] text-muted tabular-nums">
              {formatModifiedAt(entry.modifiedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
