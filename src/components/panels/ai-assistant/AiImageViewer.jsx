import { useEffect } from "react";
import { X } from "lucide-react";

export default function AiImageViewer({ viewerState, onClose }) {
  useEffect(() => {
    if (!viewerState) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, viewerState]);

  if (!viewerState) {
    return null;
  }

  const title =
    viewerState.attachment?.fileName || viewerState.label || viewerState.attachmentId || "Image";
  const imageSrc = viewerState.attachment
    ? `data:${viewerState.attachment.contentType};base64,${viewerState.attachment.contentBase64}`
    : "";

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(13,17,21,0.72)] px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-white/12 bg-[linear-gradient(180deg,rgba(253,251,247,0.96),rgba(245,240,232,0.98))] shadow-[0_32px_90px_rgba(15,20,24,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/55 px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text">{title}</div>
            {viewerState.attachment?.contentType ? (
              <div className="truncate text-xs text-muted">
                {viewerState.attachment.contentType}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-white/70 text-muted transition-colors hover:border-accent/30 hover:text-text"
            onClick={onClose}
            aria-label="Close image viewer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-[20rem] items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top,rgba(28,122,103,0.06),transparent_52%),linear-gradient(180deg,rgba(248,245,238,0.92),rgba(241,236,227,0.96))] p-5">
          {viewerState.loading ? (
            <div className="text-sm text-muted">Loading image...</div>
          ) : viewerState.error ? (
            <div className="max-w-lg text-center text-sm text-danger">
              {viewerState.error}
            </div>
          ) : (
            <img
              src={imageSrc}
              alt={title}
              className="max-h-[75vh] max-w-full rounded-[22px] border border-black/5 bg-white object-contain shadow-[0_18px_46px_rgba(18,24,28,0.18)]"
            />
          )}
        </div>
      </div>
    </div>
  );
}
