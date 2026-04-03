function WallpaperCropSlider({
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange,
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        className="w-full accent-accent"
      />
    </div>
  );
}

export default function WallpaperCropControls({
  cropZoom,
  cropPan,
  onZoomChange,
  onHorizontalChange,
  onVerticalChange,
  onReset,
  onCancel,
  onApply,
  applying,
  cropError,
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-surface/60 p-3">
      <WallpaperCropSlider
        label="Zoom"
        valueLabel={`${cropZoom.toFixed(2)}x`}
        min="1"
        max="3"
        step="0.01"
        value={cropZoom}
        onChange={onZoomChange}
      />

      <WallpaperCropSlider
        label="Horizontal"
        valueLabel={`${Math.round(cropPan.x * 100)}%`}
        min="-100"
        max="100"
        step="1"
        value={Math.round(cropPan.x * 100)}
        onChange={onHorizontalChange}
      />

      <WallpaperCropSlider
        label="Vertical"
        valueLabel={`${Math.round(cropPan.y * 100)}%`}
        min="-100"
        max="100"
        step="1"
        value={Math.round(cropPan.y * 100)}
        onChange={onVerticalChange}
      />

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          className="rounded-xl border border-border px-3 py-1.5 text-xs text-muted hover:bg-accent-soft"
          onClick={onReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="rounded-xl border border-border px-3 py-1.5 text-xs text-muted hover:bg-accent-soft"
          onClick={onCancel}
        >
          Discard
        </button>
        <button
          type="button"
          disabled={applying}
          className="rounded-xl border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          onClick={onApply}
        >
          {applying ? "Applying..." : "Apply Wallpaper"}
        </button>
      </div>

      {cropError ? <div className="text-xs text-danger">{cropError}</div> : null}
    </div>
  );
}
