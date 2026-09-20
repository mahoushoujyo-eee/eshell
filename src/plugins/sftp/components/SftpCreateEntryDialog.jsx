import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { joinPath } from "../../../utils/path";

const isValidRemoteEntryName = (value) => {
  const name = String(value || "").trim();
  return Boolean(name) && name !== "." && name !== ".." && !/[\\/]/.test(name);
};

const defaultNameFor = (entryType) => (entryType === "directory" ? "new-folder" : "new-file.txt");

export default function SftpCreateEntryDialog({
  open,
  entryType,
  currentPath,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const { t } = useI18n();
  const [type, setType] = useState(entryType === "directory" ? "directory" : "file");
  const [name, setName] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const initialType = entryType === "directory" ? "directory" : "file";
    setType(initialType);
    setName(defaultNameFor(initialType));
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [entryType, open]);

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

  // Switching type swaps the suggested name, but never discards a name the user
  // typed themselves.
  const selectType = (nextType) => {
    if (busy || nextType === type) {
      return;
    }
    setName((current) => (current === defaultNameFor(type) ? defaultNameFor(nextType) : current));
    setType(nextType);
    inputRef.current?.focus();
  };

  const trimmedName = name.trim();
  const invalidName = Boolean(trimmedName) && !isValidRemoteEntryName(trimmedName);
  const targetPath = useMemo(
    () => (trimmedName ? joinPath(currentPath || "/", trimmedName) : currentPath || "/"),
    [currentPath, trimmedName],
  );

  if (!open) {
    return null;
  }

  const submit = (event) => {
    event.preventDefault();
    if (busy || !isValidRemoteEntryName(trimmedName)) {
      return;
    }
    onConfirm?.(trimmedName, type);
  };

  const typeButtonClass = (buttonType) =>
    [
      "rounded border px-2 py-1.5 text-xs transition-colors disabled:opacity-60",
      type === buttonType ? "border-accent bg-accent-soft text-accent" : "border-border",
    ].join(" ");

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
        aria-labelledby="sftp-create-entry-title"
      >
        <h3 id="sftp-create-entry-title" className="text-base font-semibold text-text">
          {t("New")}
        </h3>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            className={typeButtonClass("file")}
            onClick={() => selectType("file")}
            disabled={busy}
            aria-pressed={type === "file"}
          >
            {t("File")}
          </button>
          <button
            type="button"
            className={typeButtonClass("directory")}
            onClick={() => selectType("directory")}
            disabled={busy}
            aria-pressed={type === "directory"}
          >
            {t("Folder")}
          </button>
        </div>

        <input
          ref={inputRef}
          className={[
            "mt-2 w-full rounded border bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-accent",
            invalidName ? "border-danger" : "border-border",
          ].join(" ")}
          placeholder={type === "directory" ? t("Folder name") : t("File name")}
          aria-label={type === "directory" ? t("Folder name") : t("File name")}
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
            disabled={busy || !isValidRemoteEntryName(trimmedName)}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {busy ? t("Creating...") : t("Create")}
          </button>
        </div>
      </form>
    </div>
  );
}
