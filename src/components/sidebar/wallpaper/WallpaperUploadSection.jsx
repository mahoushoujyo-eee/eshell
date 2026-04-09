import { Upload } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

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
    <div className="rounded-2xl border border-dashed border-border/75 bg-surface/55 p-4">
      <div className="mb-3 flex items-center justify-between rounded-xl border border-border/70 bg-panel/60 px-3 py-2">
        <div>
          <div className="text-sm font-semibold">{t("Frosted Glass")}</div>
          <div className="text-xs text-muted">
            {t("Blur wallpaper under the terminal text for readability.")}
          </div>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-text">
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{t("Custom Image")}</div>
          <div className="text-xs text-muted">
            {t("Upload a JPG, PNG, or WebP under 1.5MB, then crop and scale before applying.")}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            disabled={uploading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-accent bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {uploading
              ? t("Importing...")
              : pendingCrop
                ? t("Replace Image")
                : t("Upload Wallpaper")}
          </button>
        </div>
      </div>

      {pendingCrop ? (
        <div className="mt-3 rounded-xl border border-border/75 bg-panel/60 px-3 py-2 text-xs text-muted">
          {t("Cropping dialog is open. Source {width} x {height}", {
            width: pendingCrop.image.naturalWidth,
            height: pendingCrop.image.naturalHeight,
          })}
        </div>
      ) : null}

      {uploadError ? <div className="mt-3 text-xs text-danger">{t(uploadError)}</div> : null}
    </div>
  );
}
