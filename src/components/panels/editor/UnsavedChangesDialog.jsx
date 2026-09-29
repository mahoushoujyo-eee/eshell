import { AlertTriangle, Loader2 } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button from "../../ui/Button";
import Dialog, { DialogFooter, DialogHeader } from "../../ui/Dialog";

export default function UnsavedChangesDialog({ open, fileName, saving = false, onSave, onDiscard, onCancel }) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onClose={onCancel} dismissible={!saving} layer="stacked" size="sm" labelledBy="unsaved-changes-title">
      <DialogHeader
        icon={AlertTriangle}
        tone="warning"
        title={t("Save changes to {name}?", { name: fileName })}
        titleId="unsaved-changes-title"
        description={t("Your changes will be lost if you don't save them.")}
      />
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button variant="danger" onClick={onDiscard} disabled={saving}>
          {t("Don't Save")}
        </Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {t("Save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
