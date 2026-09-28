import { Check } from "lucide-react";

export default function WallpaperPresetCard({ active, title, style, onClick, badge = null }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={[
        "group overflow-hidden rounded-lg border bg-panel text-left transition-colors duration-150",
        active ? "border-accent ring-1 ring-accent" : "border-border hover:border-border-strong",
      ].join(" ")}
      onClick={onClick}
    >
      <div className="relative h-24 w-full" style={style}>
        {badge ? (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="truncate text-[13px] font-medium text-text">{title}</span>
        {active ? <Check className="h-4 w-4 text-accent" aria-hidden="true" /> : null}
      </div>
    </button>
  );
}
