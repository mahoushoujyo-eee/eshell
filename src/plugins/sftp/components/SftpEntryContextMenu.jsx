import { ClipboardCopy, Download, FilePenLine, PencilLine, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../../lib/i18n";

const MENU_WIDTH = 204;
const MENU_HEIGHT = 228;
const VIEWPORT_PADDING = 12;

const MENU_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-text transition-colors duration-100 hover:bg-hover";
const MENU_ICON = "h-3.5 w-3.5 text-muted";

export default function SftpEntryContextMenu({
  open,
  position,
  entry,
  onClose,
  onOpen,
  onDownload,
  onCopyPath,
  onRename,
  onDelete,
}) {
  const { t } = useI18n();
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) {
        return;
      }
      onClose?.();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
    };

    const handleWindowClose = () => {
      onClose?.();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleWindowClose);
    window.addEventListener("scroll", handleWindowClose, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleWindowClose);
      window.removeEventListener("scroll", handleWindowClose, true);
    };
  }, [onClose, open]);

  const style = useMemo(() => {
    if (!open || !position) {
      return null;
    }

    const viewportWidth = typeof window === "undefined" ? MENU_WIDTH : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? MENU_HEIGHT : window.innerHeight;
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, position.x),
      Math.max(VIEWPORT_PADDING, viewportWidth - MENU_WIDTH - VIEWPORT_PADDING),
    );
    const top = Math.min(
      Math.max(VIEWPORT_PADDING, position.y),
      Math.max(VIEWPORT_PADDING, viewportHeight - MENU_HEIGHT - VIEWPORT_PADDING),
    );

    return {
      left: `${left}px`,
      top: `${top}px`,
    };
  }, [open, position]);

  if (!open || !position || !entry || !style) {
    return null;
  }

  const fileLabel = entry.name?.trim() || entry.path || t("Selected file");
  const isDirectory = entry.entryType === "directory";

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-[204px] rounded-lg border border-border bg-elevated p-1 shadow-overlay animate-[es-fade-in_100ms_ease-out]"
      style={style}
      role="menu"
      aria-label={t("Actions for {name}", { name: fileLabel })}
    >
      <div className="px-2 pt-1 pb-1.5">
        <div className="text-[10.5px] font-medium text-subtle">
          {isDirectory ? t("Folder Actions") : t("File Actions")}
        </div>
        <div className="truncate text-xs font-medium text-text" title={entry.path}>
          {fileLabel}
        </div>
      </div>
      <div className="mx-1 mb-1 h-px bg-border" aria-hidden="true" />

      <button type="button" className={MENU_ITEM} onClick={() => onOpen?.(entry)} role="menuitem">
        <FilePenLine className={MENU_ICON} aria-hidden="true" />
        {isDirectory ? t("Open Folder") : t("Open")}
      </button>
      {!isDirectory ? (
        <button type="button" className={MENU_ITEM} onClick={() => onDownload?.(entry)} role="menuitem">
          <Download className={MENU_ICON} aria-hidden="true" />
          {t("Download")}
        </button>
      ) : null}
      <button type="button" className={MENU_ITEM} onClick={() => onCopyPath?.(entry)} role="menuitem">
        <ClipboardCopy className={MENU_ICON} aria-hidden="true" />
        {t("Copy Path")}
      </button>
      <button type="button" className={MENU_ITEM} onClick={() => onRename?.(entry)} role="menuitem">
        <PencilLine className={MENU_ICON} aria-hidden="true" />
        {t("Rename")}
      </button>
      <div className="mx-1 my-1 h-px bg-border" aria-hidden="true" />
      <button
        type="button"
        className={`${MENU_ITEM} text-danger hover:bg-danger/12 hover:text-danger`}
        onClick={() => onDelete?.(entry)}
        role="menuitem"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t("Delete")}
      </button>
    </div>
  );
}
