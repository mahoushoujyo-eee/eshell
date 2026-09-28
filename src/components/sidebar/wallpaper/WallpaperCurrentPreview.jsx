import { Trash2 } from "lucide-react";
import {
  DEFAULT_WALLPAPER,
  getWallpaperLabel,
  getWallpaperPreviewStyle,
} from "../../../constants/workbench";
import { useI18n } from "../../../lib/i18n";
import Button from "../../ui/Button";
import { sectionLabelClass } from "../../ui/fieldClasses";

export default function WallpaperCurrentPreview({
  normalized,
  onChangeWallpaper,
  onClose,
  onCancelPendingCrop,
}) {
  const { t } = useI18n();

  return (
    <section>
      <div className={`mb-2 ${sectionLabelClass}`}>{t("Current")}</div>
      <div className="grid overflow-hidden rounded-lg border border-border bg-panel md:grid-cols-[1.4fr_1fr]">
        <div className="h-32 w-full" style={getWallpaperPreviewStyle(normalized)} />
        <div className="flex flex-col justify-center border-t border-border p-4 md:border-t-0 md:border-l">
          <div className="text-[13px] font-semibold text-text">{t(getWallpaperLabel(normalized))}</div>
          <div className="mt-1 text-xs leading-relaxed text-muted">
            {normalized.type === "custom"
              ? t("Custom uploaded image. Stored locally in this app session.")
              : t("Preset wallpaper tuned for PTY readability and visible contrast.")}
          </div>
          {normalized.type === "custom" ? (
            <Button
              variant="danger"
              className="mt-3 self-start"
              onClick={() => {
                onCancelPendingCrop();
                onChangeWallpaper({ ...DEFAULT_WALLPAPER, glass: normalized.glass });
                onClose();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Remove Custom")}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
