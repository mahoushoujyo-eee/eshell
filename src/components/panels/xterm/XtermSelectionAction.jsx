import { Bot, Plus } from "lucide-react";

export default function XtermSelectionAction({ selectionLength, onClick }) {
  return (
    <button
      type="button"
      className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-accent/45 bg-panel/92 px-3 py-1.5 text-[11px] font-medium text-text shadow-[0_10px_26px_rgba(0,0,0,0.22)] backdrop-blur-md transition-colors hover:border-accent hover:bg-accent-soft"
      onClick={onClick}
      title="Add selected shell content to Ops Agent"
    >
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
        <Bot className="h-3 w-3" aria-hidden="true" />
      </span>
      <span>Add To Agent</span>
      <span className="rounded-full bg-warm px-1.5 py-0.5 font-mono text-[10px] text-muted">
        {selectionLength}
      </span>
      <Plus className="h-3 w-3 text-accent" aria-hidden="true" />
    </button>
  );
}
