import { Crop } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import Dialog, { DialogBody, DialogHeader } from "../ui/Dialog";
import WallpaperCropControls from "./wallpaper/WallpaperCropControls";
import WallpaperCropPreview from "./wallpaper/WallpaperCropPreview";
import {
  clamp,
  CROP_OUTPUT_HEIGHT,
  CROP_OUTPUT_WIDTH,
  CROP_PREVIEW_HEIGHT,
  CROP_PREVIEW_WIDTH,
  drawCroppedWallpaper,
  exportCanvasDataUrl,
  getCoverMetrics,
} from "./wallpaper/wallpaperCropUtils";

export default function WallpaperCropModal({ open, source, onCancel, onApply }) {
  const { t } = useI18n();
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

  const handleZoomChange = (event) => {
    setCropZoom(clamp(Number(event.target.value), 1, 3));
  };

  const handleHorizontalChange = (event) => {
    setCropPan((prev) => ({
      ...prev,
      x: clamp(Number(event.target.value) / 100, -1, 1),
    }));
  };

  const handleVerticalChange = (event) => {
    setCropPan((prev) => ({
      ...prev,
      y: clamp(Number(event.target.value) / 100, -1, 1),
    }));
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
        throw new Error(t("Failed to render crop preview."));
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
      setCropError(error instanceof Error ? error.message : t("Failed to apply cropped wallpaper."));
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
    <Dialog
      open
      onClose={handleCancel}
      closeOnOverlay={false}
      layer="stacked"
      size="custom"
      className="max-w-6xl"
      labelledBy="wallpaper-crop-title"
    >
      <DialogHeader
        icon={Crop}
        tone="accent"
        title={t("Crop And Scale")}
        titleId="wallpaper-crop-title"
        description={
          <span className="font-mono text-[11px]">
            {t("Source {width} x {height} | Export {outWidth} x {outHeight}", {
              width: source.image.naturalWidth,
              height: source.image.naturalHeight,
              outWidth: CROP_OUTPUT_WIDTH,
              outHeight: CROP_OUTPUT_HEIGHT,
            })}
          </span>
        }
        onClose={handleCancel}
      />

      <DialogBody className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        <WallpaperCropPreview
          previewCanvasRef={previewCanvasRef}
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerRelease={handlePreviewPointerRelease}
        />

        <WallpaperCropControls
          cropZoom={cropZoom}
          cropPan={cropPan}
          onZoomChange={handleZoomChange}
          onHorizontalChange={handleHorizontalChange}
          onVerticalChange={handleVerticalChange}
          onReset={resetCropAdjustments}
          onCancel={handleCancel}
          onApply={handleApply}
          applying={applying}
          cropError={cropError}
        />
      </DialogBody>
    </Dialog>
  );
}
