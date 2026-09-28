import { Loader2, PencilLine } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { joinPath } from "../../../utils/path";
import Button from "../../../components/ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../../../components/ui/Dialog";
import { inputClass } from "../../../components/ui/fieldClasses";

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

  const trimmedName = name.trim();
  const invalidName = Boolean(trimmedName) && !isValidRemoteEntryName(trimmedName);
  const unchanged = trimmedName === originalName;
  const targetPath = useMemo(() => {
    const parent = parentDirOf(entry?.path || "");
    return trimmedName ? joinPath(parent, trimmedName) : entry?.path || "";
  }, [entry?.path, trimmedName]);

  const submit = (event) => {
    event.preventDefault();
    if (busy || unchanged || !isValidRemoteEntryName(trimmedName)) {
      return;
    }
    onConfirm?.(trimmedName);
  };

  return (
    <Dialog
      open={Boolean(open && entry)}
      onClose={onCancel}
      dismissible={!busy}
      layer="stacked"
      size="sm"
      labelledBy="sftp-rename-entry-title"
    >
      {entry ? (
        <form className="flex min-h-0 flex-col" onSubmit={submit}>
          <DialogHeader
            icon={PencilLine}
            title={t("Rename")}
            titleId="sftp-rename-entry-title"
            description={<span className="font-mono text-[11px]">{entry.path}</span>}
            onClose={onCancel}
            closeDisabled={busy}
          />
          <DialogBody className="space-y-1.5">
            <input
              ref={inputRef}
              className={[inputClass, invalidName ? "border-danger focus:border-danger focus:ring-danger/20" : ""].join(" ")}
              placeholder={entry.entryType === "directory" ? t("Folder name") : t("File name")}
              aria-label={entry.entryType === "directory" ? t("Folder name") : t("File name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              aria-invalid={invalidName}
            />
            <div className="min-h-4 text-xs break-all">
              {invalidName ? (
                <span className="text-danger">{t("Use a name without slashes.")}</span>
              ) : (
                <span className="font-mono text-[11px] text-muted">
                  {t("Remote path: {path}", { path: targetPath })}
                </span>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || unchanged || !isValidRemoteEntryName(trimmedName)}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {t("Rename")}
            </Button>
          </DialogFooter>
        </form>
      ) : null}
    </Dialog>
  );
}
