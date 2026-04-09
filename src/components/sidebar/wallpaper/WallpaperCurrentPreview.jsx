import { Trash2 } from "lucide-react";
import {
  DEFAULT_WALLPAPER,
  getWallpaperLabel,
  getWallpaperPreviewStyle,
} from "../../../constants/workbench";
import { useI18n } from "../../../lib/i18n";

export default function WallpaperCurrentPreview({
  normalized,
  onChangeWallpaper,
  onClose,
  onCancelPendingCrop,
}) {
  const { t } = useI18n();

  return (
    <div className="mb-4 rounded-2xl border border-border/75 bg-surface/65 p-3">
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">{t("Current")}</div>
      <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-border/75">
          <div className="h-32 w-full" style={getWallpaperPreviewStyle(normalized)} />
        </div>
        <div className="rounded-2xl border border-border/75 bg-panel/80 p-3">
          <div className="text-sm font-semibold">{t(getWallpaperLabel(normalized))}</div>
          <div className="mt-1 text-xs leading-6 text-muted">
            {normalized.type === "custom"
              ? t("Custom uploaded image. Stored locally in this app session.")
              : t("Preset wallpaper tuned for PTY readability and visible contrast.")}
          </div>
          {normalized.type === "custom" ? (
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-danger/35 px-3 py-1.5 text-xs text-danger hover:bg-danger/8"
              onClick={() => {
                onCancelPendingCrop();
                onChangeWallpaper({ ...DEFAULT_WALLPAPER, glass: normalized.glass });
                onClose();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Remove Custom")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
