import { Check, Image as ImageIcon, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_WALLPAPER,
  WALLPAPER_PRESETS,
  getWallpaperLabel,
  getWallpaperPreviewStyle,
  normalizeWallpaperSelection,
} from "../../constants/workbench";
import WallpaperCropModal from "./WallpaperCropModal";

const MAX_CUSTOM_WALLPAPER_BYTES = 1_500_000;

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read image."));
    reader.readAsDataURL(file);
  });

const loadImageFromDataUrl = (dataUrl) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image."));
    image.src = dataUrl;
  });

function PresetCard({ active, title, style, onClick, badge = null }) {
  return (
    <button
      type="button"
      className={[
        "group overflow-hidden rounded-2xl border text-left transition-all",
        active
          ? "border-accent shadow-[0_16px_34px_rgba(28,122,103,0.14)]"
          : "border-border/80 hover:border-accent/45",
      ].join(" ")}
      onClick={onClick}
    >
      <div className="relative h-24 w-full" style={style}>
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/35 to-transparent" />
        {badge ? (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-white/20 bg-black/35 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="truncate text-sm font-medium">{title}</span>
        {active ? <Check className="h-4 w-4 text-accent" aria-hidden="true" /> : null}
      </div>
    </button>
  );
}

export default function WallpaperModal({ open, onClose, wallpaper, onChangeWallpaper }) {
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
      setUploadError("Only image files are supported.");
      return;
    }

    if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
      setUploadError("Use an image smaller than 1.5MB.");
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
      setUploadError(error instanceof Error ? error.message : "Failed to import wallpaper.");
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
                Terminal Wallpaper
              </h3>
              <p className="text-xs text-muted">
                Pick a preset or upload your own background for the PTY terminal.
              </p>
            </div>

            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-xl border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-accent-soft"
              onClick={handleClose}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Close
            </button>
          </div>

          <div className="mb-4 rounded-2xl border border-border/75 bg-surface/65 p-3">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Current</div>
            <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
              <div className="overflow-hidden rounded-2xl border border-border/75">
                <div className="h-32 w-full" style={getWallpaperPreviewStyle(normalized)} />
              </div>
              <div className="rounded-2xl border border-border/75 bg-panel/80 p-3">
                <div className="text-sm font-semibold">{getWallpaperLabel(normalized)}</div>
                <div className="mt-1 text-xs leading-6 text-muted">
                  {normalized.type === "custom"
                    ? "Custom uploaded image. Stored locally in this app session."
                    : "Preset wallpaper tuned for PTY readability and visible contrast."}
                </div>
                {normalized.type === "custom" ? (
                  <button
                    type="button"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-danger/35 px-3 py-1.5 text-xs text-danger hover:bg-danger/8"
                    onClick={() => {
                      cancelPendingCrop();
                      onChangeWallpaper({ ...DEFAULT_WALLPAPER, glass: normalized.glass });
                      onClose();
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Remove Custom
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mb-4">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Presets</div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {WALLPAPER_PRESETS.map((preset) => (
                <PresetCard
                  key={preset.id}
                  active={normalized.type === "preset" && normalized.id === preset.id}
                  title={preset.name}
                  style={getWallpaperPreviewStyle({ type: "preset", id: preset.id })}
                  onClick={() => choosePreset(preset.id)}
                />
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-dashed border-border/75 bg-surface/55 p-4">
            <div className="mb-3 flex items-center justify-between rounded-xl border border-border/70 bg-panel/60 px-3 py-2">
              <div>
                <div className="text-sm font-semibold">Frosted Glass</div>
                <div className="text-xs text-muted">Blur wallpaper under the terminal text for readability.</div>
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
                Enabled
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Custom Image</div>
                <div className="text-xs text-muted">
                  Upload a JPG, PNG, or WebP under 1.5MB, then crop and scale before applying.
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
                  {uploading ? "Importing..." : pendingCrop ? "Replace Image" : "Upload Wallpaper"}
                </button>
              </div>
            </div>

            {pendingCrop ? (
              <div className="mt-3 rounded-xl border border-border/75 bg-panel/60 px-3 py-2 text-xs text-muted">
                Cropping dialog is open. Source {pendingCrop.image.naturalWidth} x {pendingCrop.image.naturalHeight}
              </div>
            ) : null}

            {uploadError ? <div className="mt-3 text-xs text-danger">{uploadError}</div> : null}
          </div>
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
