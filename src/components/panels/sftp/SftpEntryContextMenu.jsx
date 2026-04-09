import { Download, FilePenLine, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../../lib/i18n";

const MENU_WIDTH = 204;
const MENU_HEIGHT = 156;
const VIEWPORT_PADDING = 12;

export default function SftpEntryContextMenu({
  open,
  position,
  entry,
  onClose,
  onOpen,
  onDownload,
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
      className="fixed z-50 w-[204px] rounded-[22px] border border-border/85 bg-panel/98 p-2 shadow-[0_22px_60px_rgba(34,26,16,0.22)] ring-1 ring-white/45 backdrop-blur-[6px]"
      style={style}
      role="menu"
      aria-label={t("Actions for {name}", { name: fileLabel })}
    >
      <div className="border-b border-border/70 px-2 pb-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted/80">
          {isDirectory ? t("Folder Actions") : t("File Actions")}
        </div>
        <div className="mt-1 truncate text-sm font-medium text-text" title={entry.path}>
          {fileLabel}
        </div>
      </div>

      <div className="mt-2 space-y-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent-soft/70"
          onClick={() => onOpen?.(entry)}
          role="menuitem"
        >
          <FilePenLine className="h-4 w-4 text-accent" aria-hidden="true" />
          {isDirectory ? t("Open Folder") : t("Open")}
        </button>
        {!isDirectory ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent-soft/70"
            onClick={() => onDownload?.(entry)}
            role="menuitem"
          >
            <Download className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("Download")}
          </button>
        ) : null}
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-danger transition-colors hover:bg-danger/10"
          onClick={() => onDelete?.(entry)}
          role="menuitem"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t("Delete")}
        </button>
      </div>
    </div>
  );
}
