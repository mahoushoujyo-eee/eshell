import { CROP_PREVIEW_HEIGHT, CROP_PREVIEW_WIDTH } from "./wallpaperCropUtils";

export default function WallpaperCropPreview({
  previewCanvasRef,
  onPointerDown,
  onPointerMove,
  onPointerRelease,
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[#0b0e14] p-2">
      <canvas
        ref={previewCanvasRef}
        width={CROP_PREVIEW_WIDTH}
        height={CROP_PREVIEW_HEIGHT}
        className="h-auto w-full cursor-grab touch-none rounded-md bg-black/45 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerRelease}
        onPointerCancel={onPointerRelease}
      />
      <div className="mt-2 text-[11px] text-[#8a93a9]">Drag the preview to move the crop area.</div>
    </div>
  );
}
