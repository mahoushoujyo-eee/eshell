import { CROP_PREVIEW_HEIGHT, CROP_PREVIEW_WIDTH } from "./wallpaperCropUtils";

export default function WallpaperCropPreview({
  previewCanvasRef,
  onPointerDown,
  onPointerMove,
  onPointerRelease,
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-black/35 p-2">
      <canvas
        ref={previewCanvasRef}
        width={CROP_PREVIEW_WIDTH}
        height={CROP_PREVIEW_HEIGHT}
        className="h-auto w-full touch-none rounded-xl border border-border/70 bg-black/45"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerRelease}
        onPointerCancel={onPointerRelease}
      />
      <div className="mt-2 text-[11px] text-muted">Drag the preview to move the crop area.</div>
    </div>
  );
}
