import { Upload } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button from "../../ui/Button";

export default function WallpaperUploadSection({
  normalized,
  onChangeWallpaper,
  fileInputRef,
  handleFileChange,
  uploading,
  pendingCrop,
  uploadError,
}) {
  const { t } = useI18n();

  return (
    <section className="divide-y divide-border rounded-lg border border-border bg-panel">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text">{t("Frosted Glass")}</div>
          <div className="text-xs text-muted">{t("Blur wallpaper under the terminal text for readability.")}</div>
        </div>
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-text">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={Boolean(normalized.glass)}
            onChange={(event) =>
              onChangeWallpaper({
                ...normalized,
                glass: event.target.checked,
              })
            }
          />
          {t("Enabled")}
        </label>
      </div>

      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text">{t("Custom Image")}</div>
            <div className="text-xs text-muted">
              {t("Upload a JPG, PNG, or WebP under 1.5MB, then crop and scale before applying.")}
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button variant="primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {uploading ? t("Importing...") : pendingCrop ? t("Replace Image") : t("Upload Wallpaper")}
          </Button>
        </div>

        {pendingCrop ? (
          <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
            {t("Cropping dialog is open. Source {width} x {height}", {
              width: pendingCrop.image.naturalWidth,
              height: pendingCrop.image.naturalHeight,
            })}
          </div>
        ) : null}

        {uploadError ? <div className="mt-3 text-xs text-danger">{t(uploadError)}</div> : null}
      </div>
    </section>
  );
}
