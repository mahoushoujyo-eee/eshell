import { FilePlus2, FolderPlus, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { joinPath } from "../../../utils/path";

const isValidRemoteEntryName = (value) => {
  const name = String(value || "").trim();
  return Boolean(name) && name !== "." && name !== ".." && !/[\\/]/.test(name);
};

export default function SftpCreateEntryDialog({
  open,
  entryType,
  currentPath,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const inputRef = useRef(null);
  const isDirectory = entryType === "directory";

  useEffect(() => {
    if (!open) {
      return;
    }

    setName(isDirectory ? "new-folder" : "new-file.txt");
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [isDirectory, open]);

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
  const targetPath = useMemo(
    () => (trimmedName ? joinPath(currentPath || "/", trimmedName) : currentPath || "/"),
    [currentPath, trimmedName],
  );

  if (!open) {
    return null;
  }

  const Icon = isDirectory ? FolderPlus : FilePlus2;
  const title = isDirectory ? t("Create remote folder") : t("Create remote file");

  const submit = (event) => {
    event.preventDefault();
    if (busy || !isValidRemoteEntryName(trimmedName)) {
      return;
    }
    onConfirm?.(trimmedName);
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-[rgba(26,20,14,0.28)] p-4 backdrop-blur-[2px]"
      onClick={busy ? undefined : onCancel}
    >
      <form
        className="w-full max-w-md rounded-[26px] border border-border/85 bg-panel/98 p-5 shadow-[0_28px_80px_rgba(34,26,16,0.22)] ring-1 ring-white/45"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-create-entry-title"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent-soft text-accent">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div
              id="sftp-create-entry-title"
              className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent/80"
            >
              {isDirectory ? t("New folder") : t("New file")}
            </div>
            <h3 className="mt-1 text-lg font-semibold text-text">{title}</h3>
            <p className="mt-2 break-all text-sm leading-6 text-muted">
              {t("Path: {path}", { path: currentPath || "/" })}
            </p>
          </div>
        </div>

        <label className="mt-5 block text-xs font-semibold uppercase tracking-[0.14em] text-muted/80">
          {isDirectory ? t("Folder name") : t("File name")}
        </label>
        <input
          ref={inputRef}
          className={[
            "mt-2 w-full rounded-2xl border bg-surface px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/15",
            invalidName ? "border-danger/70 focus:border-danger focus:ring-danger/15" : "border-border/80",
          ].join(" ")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          aria-invalid={invalidName}
        />
        <div className="mt-2 min-h-5 text-xs">
          {invalidName ? (
            <span className="text-danger">{t("Use a name without slashes.")}</span>
          ) : (
            <span className="break-all text-muted">{t("Remote path: {path}", { path: targetPath })}</span>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-border/80 bg-surface px-4 py-2 text-sm text-muted transition-colors hover:bg-warm disabled:cursor-not-allowed disabled:opacity-55"
            onClick={onCancel}
            disabled={busy}
          >
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-accent/60 bg-accent px-4 py-2 text-sm font-medium text-white shadow-[0_12px_28px_rgba(26,127,106,0.22)] transition-colors hover:bg-[#166d5d] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy || !isValidRemoteEntryName(trimmedName)}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Icon className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? t("Creating...") : t("Create")}
          </button>
        </div>
      </form>
    </div>
  );
}
