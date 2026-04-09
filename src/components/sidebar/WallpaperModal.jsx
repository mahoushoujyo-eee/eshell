import { Image as ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  WALLPAPER_PRESETS,
  getWallpaperPreviewStyle,
  normalizeWallpaperSelection,
} from "../../constants/workbench";
import WallpaperCropModal from "./WallpaperCropModal";
import WallpaperCurrentPreview from "./wallpaper/WallpaperCurrentPreview";
import WallpaperPresetCard from "./wallpaper/WallpaperPresetCard";
import WallpaperUploadSection from "./wallpaper/WallpaperUploadSection";
import {
  loadImageFromDataUrl,
  MAX_CUSTOM_WALLPAPER_BYTES,
  readFileAsDataUrl,
} from "./wallpaper/wallpaperUtils";
import { useI18n } from "../../lib/i18n";

export default function WallpaperModal({ open, onClose, wallpaper, onChangeWallpaper }) {
  const { t } = useI18n();
  const fileInputRef = useRef(null);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pendingCrop, setPendingCrop] = useState(null);
  const normalized = normalizeWallpaperSelection(wallpaper);

  useEffect(() => {
    if (!open) {
      setPendingCrop(null);
      setUploadError("");
      setUploading(false);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const cancelPendingCrop = () => {
    setPendingCrop(null);
  };

  const handleClose = () => {
    cancelPendingCrop();
    setUploadError("");
    onClose();
  };

  const choosePreset = (id) => {
    cancelPendingCrop();
    setUploadError("");
    onChangeWallpaper({ type: "preset", id, glass: normalized.glass });
    onClose();
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setUploadError(t("Only image files are supported."));
      return;
    }

    if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
      setUploadError(t("Use an image smaller than 1.5MB."));
      return;
    }

    setUploadError("");
    setUploading(true);

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const image = await loadImageFromDataUrl(dataUrl);

      setPendingCrop({
        name: file.name.replace(/\.[^.]+$/, "") || "Custom Wallpaper",
        image,
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t("Failed to import wallpaper."));
    } finally {
      setUploading(false);
    }
  };

  const handleApplyCrop = (dataUrl) => {
    if (!pendingCrop?.image) {
      return;
    }
    onChangeWallpaper({
      type: "custom",
      name: pendingCrop.name,
      dataUrl,
      glass: normalized.glass,
    });

    cancelPendingCrop();
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={handleClose}>
        <div
          className="w-full max-w-4xl rounded-3xl border border-border/80 bg-panel p-5 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <ImageIcon className="h-4 w-4 text-accent" aria-hidden="true" />
                {t("Terminal Wallpaper")}
              </h3>
              <p className="text-xs text-muted">
                {t("Pick a preset or upload your own background for the PTY terminal.")}
              </p>
            </div>

            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-xl border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-accent-soft"
              onClick={handleClose}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Close")}
            </button>
          </div>

          <WallpaperCurrentPreview
            normalized={normalized}
            onChangeWallpaper={onChangeWallpaper}
            onClose={onClose}
            onCancelPendingCrop={cancelPendingCrop}
          />

          <div className="mb-4">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              {t("Presets")}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {WALLPAPER_PRESETS.map((preset) => (
                <WallpaperPresetCard
                  key={preset.id}
                  active={normalized.type === "preset" && normalized.id === preset.id}
                  title={t(preset.name)}
                  style={getWallpaperPreviewStyle({ type: "preset", id: preset.id })}
                  onClick={() => choosePreset(preset.id)}
                />
              ))}
            </div>
          </div>
          <WallpaperUploadSection
            normalized={normalized}
            onChangeWallpaper={onChangeWallpaper}
            fileInputRef={fileInputRef}
            handleFileChange={handleFileChange}
            uploading={uploading}
            pendingCrop={pendingCrop}
            uploadError={uploadError}
          />
        </div>
      </div>

      <WallpaperCropModal
        open={Boolean(pendingCrop)}
        source={pendingCrop}
        onCancel={cancelPendingCrop}
        onApply={handleApplyCrop}
      />
    </>
  );
}
