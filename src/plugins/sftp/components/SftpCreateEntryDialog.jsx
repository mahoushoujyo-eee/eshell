import { File, Folder, FolderPlus, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { joinPath } from "../../../utils/path";
import Button from "../../../components/ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../../../components/ui/Dialog";
import SegmentedControl from "../../../components/ui/SegmentedControl";
import { inputClass } from "../../../components/ui/fieldClasses";

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

  const submit = (event) => {
    event.preventDefault();
    if (busy || !isValidRemoteEntryName(trimmedName)) {
      return;
    }
    onConfirm?.(trimmedName, type);
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      dismissible={!busy}
      layer="stacked"
      size="sm"
      labelledBy="sftp-create-entry-title"
    >
      <form className="flex min-h-0 flex-col" onSubmit={submit}>
        <DialogHeader
          icon={FolderPlus}
          tone="accent"
          title={t("New")}
          titleId="sftp-create-entry-title"
          onClose={onCancel}
          closeDisabled={busy}
        />
        <DialogBody className="space-y-3">
          <SegmentedControl
            size="sm"
            value={type}
            onChange={selectType}
            options={[
              { id: "file", label: t("File"), icon: File },
              { id: "directory", label: t("Folder"), icon: Folder },
            ]}
          />
          <div className="space-y-1.5">
            <input
              ref={inputRef}
              className={[inputClass, invalidName ? "border-danger focus:border-danger focus:ring-danger/20" : ""].join(" ")}
              placeholder={type === "directory" ? t("Folder name") : t("File name")}
              aria-label={type === "directory" ? t("Folder name") : t("File name")}
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
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !isValidRemoteEntryName(trimmedName)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {busy ? t("Creating...") : t("Create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
