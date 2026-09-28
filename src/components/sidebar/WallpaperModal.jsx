import { Image as ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Dialog, { DialogBody, DialogHeader } from "../ui/Dialog";
import { sectionLabelClass } from "../ui/fieldClasses";
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
      <Dialog open onClose={handleClose} size="custom" className="max-w-4xl" labelledBy="wallpaper-title">
        <DialogHeader
          icon={ImageIcon}
          tone="accent"
          title={t("Terminal Wallpaper")}
          titleId="wallpaper-title"
          description={t("Pick a preset or upload your own background for the PTY terminal.")}
          onClose={handleClose}
        />

        <DialogBody className="space-y-5">
          <WallpaperCurrentPreview
            normalized={normalized}
            onChangeWallpaper={onChangeWallpaper}
            onClose={onClose}
            onCancelPendingCrop={cancelPendingCrop}
          />

          <section>
            <div className={`mb-2 ${sectionLabelClass}`}>{t("Presets")}</div>
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
          </section>

          <WallpaperUploadSection
            normalized={normalized}
            onChangeWallpaper={onChangeWallpaper}
            fileInputRef={fileInputRef}
            handleFileChange={handleFileChange}
            uploading={uploading}
            pendingCrop={pendingCrop}
            uploadError={uploadError}
          />
        </DialogBody>
      </Dialog>

      <WallpaperCropModal
        open={Boolean(pendingCrop)}
        source={pendingCrop}
        onCancel={cancelPendingCrop}
        onApply={handleApplyCrop}
      />
    </>
  );
}
