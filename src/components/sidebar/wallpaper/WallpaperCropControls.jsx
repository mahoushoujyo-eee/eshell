import { useI18n } from "../../../lib/i18n";
import Button from "../../ui/Button";

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
      <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="font-mono text-[11px] text-text tabular-nums">{valueLabel}</span>
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
  const { t } = useI18n();

  return (
    <div className="space-y-4 rounded-lg border border-border bg-panel p-4">
      <WallpaperCropSlider
        label={t("Zoom")}
        valueLabel={`${cropZoom.toFixed(2)}x`}
        min="1"
        max="3"
        step="0.01"
        value={cropZoom}
        onChange={onZoomChange}
      />

      <WallpaperCropSlider
        label={t("Horizontal")}
        valueLabel={`${Math.round(cropPan.x * 100)}%`}
        min="-100"
        max="100"
        step="1"
        value={Math.round(cropPan.x * 100)}
        onChange={onHorizontalChange}
      />

      <WallpaperCropSlider
        label={t("Vertical")}
        valueLabel={`${Math.round(cropPan.y * 100)}%`}
        min="-100"
        max="100"
        step="1"
        value={Math.round(cropPan.y * 100)}
        onChange={onVerticalChange}
      />

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="ghost" onClick={onReset}>
          {t("Reset")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t("Discard")}
        </Button>
        <Button variant="primary" disabled={applying} onClick={onApply}>
          {applying ? t("Applying...") : t("Apply Wallpaper")}
        </Button>
      </div>
      {cropError ? <div className="text-xs text-danger">{t(cropError)}</div> : null}
    </div>
  );
}
