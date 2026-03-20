import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MAX_CUSTOM_WALLPAPER_DATA_URL_LENGTH = 2_900_000;
const CROP_OUTPUT_WIDTH = 1920;
const CROP_OUTPUT_HEIGHT = 1080;
const CROP_PREVIEW_WIDTH = 960;
const CROP_PREVIEW_HEIGHT = 540;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getCoverMetrics = ({ image, targetWidth, targetHeight, zoom }) => {
  const safeZoom = clamp(Number(zoom) || 1, 1, 3);
  const baseScale = Math.max(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight);
  const scaledWidth = image.naturalWidth * baseScale * safeZoom;
  const scaledHeight = image.naturalHeight * baseScale * safeZoom;

  return {
    scaledWidth,
    scaledHeight,
    maxOffsetX: Math.max(0, (scaledWidth - targetWidth) / 2),
    maxOffsetY: Math.max(0, (scaledHeight - targetHeight) / 2),
  };
};

const drawCroppedWallpaper = ({ ctx, image, targetWidth, targetHeight, zoom, panX, panY }) => {
  const metrics = getCoverMetrics({ image, targetWidth, targetHeight, zoom });
  const safePanX = clamp(Number(panX) || 0, -1, 1);
  const safePanY = clamp(Number(panY) || 0, -1, 1);

  const drawX = (targetWidth - metrics.scaledWidth) / 2 + safePanX * metrics.maxOffsetX;
  const drawY = (targetHeight - metrics.scaledHeight) / 2 + safePanY * metrics.maxOffsetY;

  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.fillStyle = "#081214";
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(image, drawX, drawY, metrics.scaledWidth, metrics.scaledHeight);

  return metrics;
};

const exportCanvasDataUrl = (canvas) => {
  const qualities = [0.9, 0.82, 0.74];
  for (const quality of qualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_CUSTOM_WALLPAPER_DATA_URL_LENGTH) {
      return dataUrl;
    }
  }
  return canvas.toDataURL("image/jpeg", 0.66);
};

export default function WallpaperCropModal({ open, source, onCancel, onApply }) {
  const previewCanvasRef = useRef(null);
  const dragStateRef = useRef(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPan, setCropPan] = useState({ x: 0, y: 0 });
  const [applying, setApplying] = useState(false);
  const [cropError, setCropError] = useState("");

  useEffect(() => {
    if (!open || !source?.image) {
      dragStateRef.current = null;
      setCropZoom(1);
      setCropPan({ x: 0, y: 0 });
      setApplying(false);
      setCropError("");
    }
  }, [open, source]);

  useEffect(() => {
    if (!open || !source?.image || !previewCanvasRef.current) {
      return;
    }

    const ctx = previewCanvasRef.current.getContext("2d");
    if (!ctx) {
      return;
    }

    drawCroppedWallpaper({
      ctx,
      image: source.image,
      targetWidth: CROP_PREVIEW_WIDTH,
      targetHeight: CROP_PREVIEW_HEIGHT,
      zoom: cropZoom,
      panX: cropPan.x,
      panY: cropPan.y,
    });
  }, [open, source, cropZoom, cropPan]);

  if (!open || !source?.image) {
    return null;
  }

  const resetCropAdjustments = () => {
    setCropZoom(1);
    setCropPan({ x: 0, y: 0 });
  };

  const handleCancel = () => {
    dragStateRef.current = null;
    setApplying(false);
    setCropError("");
    onCancel?.();
  };

  const handleApply = async () => {
    setCropError("");
    setApplying(true);

    try {
      const canvas = document.createElement("canvas");
      canvas.width = CROP_OUTPUT_WIDTH;
      canvas.height = CROP_OUTPUT_HEIGHT;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        throw new Error("Failed to render crop preview.");
      }

      drawCroppedWallpaper({
        ctx,
        image: source.image,
        targetWidth: CROP_OUTPUT_WIDTH,
        targetHeight: CROP_OUTPUT_HEIGHT,
        zoom: cropZoom,
        panX: cropPan.x,
        panY: cropPan.y,
      });

      await Promise.resolve(onApply?.(exportCanvasDataUrl(canvas)));
    } catch (error) {
      setCropError(error instanceof Error ? error.message : "Failed to apply cropped wallpaper.");
      setApplying(false);
      return;
    }

    setApplying(false);
  };

  const handlePreviewPointerDown = (event) => {
    event.preventDefault();

    const metrics = getCoverMetrics({
      image: source.image,
      targetWidth: CROP_PREVIEW_WIDTH,
      targetHeight: CROP_PREVIEW_HEIGHT,
      zoom: cropZoom,
    });

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: cropPan.x,
      startPanY: cropPan.y,
      maxOffsetX: metrics.maxOffsetX,
      maxOffsetY: metrics.maxOffsetY,
    };

    previewCanvasRef.current?.setPointerCapture?.(event.pointerId);
  };

  const handlePreviewPointerMove = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;

    const nextPanX =
      dragState.startPanX + (dragState.maxOffsetX > 0 ? deltaX / dragState.maxOffsetX : 0);
    const nextPanY =
      dragState.startPanY + (dragState.maxOffsetY > 0 ? deltaY / dragState.maxOffsetY : 0);

    setCropPan({
      x: clamp(nextPanX, -1, 1),
      y: clamp(nextPanY, -1, 1),
    });
  };

  const handlePreviewPointerRelease = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (previewCanvasRef.current?.hasPointerCapture?.(event.pointerId)) {
      previewCanvasRef.current.releasePointerCapture(event.pointerId);
    }

    dragStateRef.current = null;
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4">
      <div
        className="w-full max-w-6xl rounded-3xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Crop And Scale</div>
            <div className="text-xs text-muted">
              Source {source.image.naturalWidth} x {source.image.naturalHeight} | Export {CROP_OUTPUT_WIDTH} x {CROP_OUTPUT_HEIGHT}
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-xl border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-accent-soft"
            onClick={handleCancel}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-black/35 p-2">
            <canvas
              ref={previewCanvasRef}
              width={CROP_PREVIEW_WIDTH}
              height={CROP_PREVIEW_HEIGHT}
              className="h-auto w-full touch-none rounded-xl border border-border/70 bg-black/45"
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={handlePreviewPointerMove}
              onPointerUp={handlePreviewPointerRelease}
              onPointerCancel={handlePreviewPointerRelease}
            />
            <div className="mt-2 text-[11px] text-muted">Drag the preview to move the crop area.</div>
          </div>

          <div className="space-y-3 rounded-2xl border border-border/70 bg-surface/60 p-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted">
                <span>Zoom</span>
                <span>{cropZoom.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={cropZoom}
                onChange={(event) => setCropZoom(clamp(Number(event.target.value), 1, 3))}
                className="w-full accent-accent"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted">
                <span>Horizontal</span>
                <span>{Math.round(cropPan.x * 100)}%</span>
              </div>
              <input
                type="range"
                min="-100"
                max="100"
                step="1"
                value={Math.round(cropPan.x * 100)}
                onChange={(event) =>
                  setCropPan((prev) => ({
                    ...prev,
                    x: clamp(Number(event.target.value) / 100, -1, 1),
                  }))
                }
                className="w-full accent-accent"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted">
                <span>Vertical</span>
                <span>{Math.round(cropPan.y * 100)}%</span>
              </div>
              <input
                type="range"
                min="-100"
                max="100"
                step="1"
                value={Math.round(cropPan.y * 100)}
                onChange={(event) =>
                  setCropPan((prev) => ({
                    ...prev,
                    y: clamp(Number(event.target.value) / 100, -1, 1),
                  }))
                }
                className="w-full accent-accent"
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="rounded-xl border border-border px-3 py-1.5 text-xs text-muted hover:bg-accent-soft"
                onClick={resetCropAdjustments}
              >
                Reset
              </button>
              <button
                type="button"
                className="rounded-xl border border-border px-3 py-1.5 text-xs text-muted hover:bg-accent-soft"
                onClick={handleCancel}
              >
                Discard
              </button>
              <button
                type="button"
                disabled={applying}
                className="rounded-xl border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                onClick={handleApply}
              >
                {applying ? "Applying..." : "Apply Wallpaper"}
              </button>
            </div>

            {cropError ? <div className="text-xs text-danger">{cropError}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
