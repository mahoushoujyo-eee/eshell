import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { joinPath } from "../../../utils/path";

const isValidRemoteEntryName = (value) => {
  const name = String(value || "").trim();
  return Boolean(name) && name !== "." && name !== ".." && !/[\\/]/.test(name);
};

const parentDirOf = (path) => {
  const trimmed = String(path || "").replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return trimmed.slice(0, lastSlash);
};

export default function SftpRenameEntryDialog({ open, entry, busy = false, onCancel, onConfirm }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const inputRef = useRef(null);

  const originalName = entry?.name?.trim() || "";

  useEffect(() => {
    if (!open) {
      return;
    }

    setName(originalName);
    window.setTimeout(() => {
      inputRef.current?.focus();
      // Preselect the stem so the extension survives a straight retype.
      const dot = originalName.lastIndexOf(".");
      if (dot > 0) {
        inputRef.current?.setSelectionRange(0, dot);
      } else {
        inputRef.current?.select();
      }
    }, 0);
  }, [open, originalName]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, open]);

  const trimmedName = name.trim();
  const invalidName = Boolean(trimmedName) && !isValidRemoteEntryName(trimmedName);
  const unchanged = trimmedName === originalName;
  const targetPath = useMemo(() => {
    const parent = parentDirOf(entry?.path || "");
    return trimmedName ? joinPath(parent, trimmedName) : entry?.path || "";
  }, [entry?.path, trimmedName]);

  if (!open || !entry) {
    return null;
  }

  const submit = (event) => {
    event.preventDefault();
    if (busy || unchanged || !isValidRemoteEntryName(trimmedName)) {
      return;
    }
    onConfirm?.(trimmedName);
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/45 p-4"
      onClick={busy ? undefined : onCancel}
    >
      <form
        className="w-full max-w-md rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-rename-entry-title"
      >
        <h3 id="sftp-rename-entry-title" className="text-base font-semibold text-text">
          {t("Rename")}
        </h3>

        <input
          ref={inputRef}
          className={[
            "mt-3 w-full rounded border bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-accent",
            invalidName ? "border-danger" : "border-border",
          ].join(" ")}
          placeholder={entry.entryType === "directory" ? t("Folder name") : t("File name")}
          aria-label={entry.entryType === "directory" ? t("Folder name") : t("File name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          aria-invalid={invalidName}
        />

        <div className="mt-1.5 min-h-4 break-all text-xs">
          {invalidName ? (
            <span className="text-danger">{t("Use a name without slashes.")}</span>
          ) : (
            <span className="text-muted">{t("Remote path: {path}", { path: targetPath })}</span>
          )}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-accent-soft disabled:opacity-60"
            onClick={onCancel}
            disabled={busy}
          >
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            disabled={busy || unchanged || !isValidRemoteEntryName(trimmedName)}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t("Rename")}
          </button>
        </div>
      </form>
    </div>
  );
}
