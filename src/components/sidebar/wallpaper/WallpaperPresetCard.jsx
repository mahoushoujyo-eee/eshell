import { Check } from "lucide-react";

export default function WallpaperPresetCard({ active, title, style, onClick, badge = null }) {
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
