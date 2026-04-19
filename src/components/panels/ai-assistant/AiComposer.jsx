import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ImagePlus,
  Send,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import ProviderIcon from "../../ai/ProviderIcon";
import { getAiProviderMeta } from "../../../lib/aiProviderTypes";
import { useI18n } from "../../../lib/i18n";
import { formatBytes } from "../../../utils/format";
import { ShellContextChip } from "./AiAssistantControls";

export default function AiComposer({
  isDrawer,
  aiProfiles,
  activeAiProfileId,
  onSelectAiProfile,
  approvalMode,
  shellContext,
  aiImageAttachments,
  onAttachAiImages,
  onRemoveAiImageAttachment,
  onClearAiImageAttachments,
  onClearShellContext,
  aiQuestion,
  setAiQuestion,
  onAskAi,
  onCancelStreaming,
  onSaveApprovalMode,
  isStreaming,
  hasManagedShell,
}) {
  const { t } = useI18n();
  const textareaRef = useRef(null);
  const modelPickerRef = useRef(null);
  const imageInputRef = useRef(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const isAutoExecute = approvalMode === "auto_execute";
  const canSend = aiQuestion.trim() || aiImageAttachments.length > 0;
  const minComposerHeight = hasManagedShell ? 112 : 88;
  const maxComposerHeight = hasManagedShell ? 260 : 220;
  const activeProfile = useMemo(
    () => aiProfiles.find((profile) => profile.id === activeAiProfileId) || null,
    [activeAiProfileId, aiProfiles],
  );
  const activeModelLabel = activeProfile?.model || t("No AI profile");

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, minComposerHeight),
      maxComposerHeight,
    );
    textarea.style.height = `${nextHeight}px`;
  }, [aiQuestion, maxComposerHeight, minComposerHeight]);

  useEffect(() => {
    if (!modelMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (modelPickerRef.current?.contains(event.target)) {
        return;
      }
      setModelMenuOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setModelMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelMenuOpen]);

  const handleInputKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    onAskAi(event);
  };

  return (
    <form
      className={[
        "shrink-0 px-3 pb-3",
        isDrawer ? "bg-surface/18 pt-1" : "bg-panel pt-1",
      ].join(" ")}
      onSubmit={onAskAi}
      data-tauri-no-drag
    >
      {shellContext ? (
        <div className="mb-2 flex items-center">
          <ShellContextChip shellContext={shellContext} removable onRemove={onClearShellContext} />
        </div>
      ) : null}

      {aiImageAttachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {aiImageAttachments.map((attachment, index) => (
            <div
              key={attachment.localId}
              className="flex min-w-0 max-w-full items-center gap-2 rounded-[18px] border border-border/55 bg-surface/82 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.fileName || `${t("Image")} ${index + 1}`}
                className="h-11 w-11 rounded-[12px] object-cover"
              />
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-text">
                  {attachment.fileName || `${t("Image")} ${index + 1}`}
                </div>
                <div className="truncate text-[10px] text-muted">
                  {formatBytes(attachment.sizeBytes)} · {attachment.contentType}
                </div>
              </div>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-black/5 hover:text-text"
                onClick={() => onRemoveAiImageAttachment(attachment.localId)}
                aria-label={t("Remove")}
                data-tauri-no-drag
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {aiImageAttachments.length > 1 ? (
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-full border border-border/55 bg-surface/78 px-3 text-[11px] font-medium text-muted transition-colors hover:border-accent/30 hover:bg-surface hover:text-text"
              onClick={onClearAiImageAttachments}
              data-tauri-no-drag
            >
              {t("Clear")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className={[
          "rounded-[26px] bg-transparent p-0 transition-all duration-200",
          "focus-within:bg-[radial-gradient(circle_at_center,rgba(28,122,103,0.05),transparent_68%)]",
        ].join(" ")}
      >
        <div className="relative overflow-visible rounded-[22px] border border-border/50 bg-panel/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          <textarea
            ref={textareaRef}
            className="w-full resize-none border-0 bg-transparent px-4 py-3 text-sm leading-6 text-text outline-none placeholder:text-muted/72"
            style={{
              minHeight: `${minComposerHeight}px`,
              maxHeight: `${maxComposerHeight}px`,
            }}
            value={aiQuestion}
            onChange={(event) => setAiQuestion(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t("Ask the ops agent about diagnostics, root cause, or safe commands...")}
            data-tauri-no-drag
          />

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              const { files } = event.target;
              if (files?.length) {
                void onAttachAiImages(files);
              }
              event.target.value = "";
            }}
            data-tauri-no-drag
          />

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/45 bg-transparent px-3 py-1.5">
            <div className="mr-auto flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/55 bg-surface/82 text-muted transition-colors hover:border-accent/28 hover:bg-surface hover:text-text"
                  onClick={() => imageInputRef.current?.click()}
                  title={t("Attach image")}
                  aria-label={t("Attach image")}
                  data-tauri-no-drag
                >
                  <ImagePlus className="h-4 w-4" />
                </button>

                <div ref={modelPickerRef} className="relative min-w-0" data-tauri-no-drag>
                  <button
                    type="button"
                    className="inline-flex min-w-0 max-w-[13rem] items-center gap-2 rounded-full border border-border/55 bg-surface/82 px-3 py-1.5 text-[12px] text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-all hover:border-accent/28 hover:bg-surface"
                    onClick={() => {
                      if (aiProfiles.length > 0) {
                        setModelMenuOpen((current) => !current);
                      }
                    }}
                    disabled={aiProfiles.length === 0}
                    title={activeModelLabel}
                    aria-label={t("Model")}
                    aria-expanded={modelMenuOpen}
                    data-tauri-no-drag
                  >
                    <ProviderIcon apiType={activeProfile?.apiType} className="h-6 w-6 shrink-0" />
                    <span className="truncate">{activeModelLabel}</span>
                    <ChevronDown
                      className={[
                        "h-3.5 w-3.5 shrink-0 text-muted transition-transform",
                        modelMenuOpen ? "rotate-180" : "",
                      ].join(" ")}
                      aria-hidden="true"
                    />
                  </button>

                  {modelMenuOpen ? (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-[16rem] overflow-hidden rounded-[22px] border border-border/70 bg-panel/96 shadow-[0_18px_42px_rgba(0,0,0,0.22)] backdrop-blur-xl">
                      <div className="px-4 pb-1 pt-3 text-[11px] font-medium tracking-[0.08em] text-muted">
                        {t("Model")}
                      </div>
                      <div className="max-h-72 overflow-auto px-2 pb-2">
                        {aiProfiles.map((profile) => {
                          const selected = profile.id === activeAiProfileId;
                          const provider = getAiProviderMeta(profile.apiType);
                          return (
                            <button
                              key={profile.id}
                              type="button"
                              className={[
                                "flex w-full items-center justify-between gap-3 rounded-[16px] px-3 py-2.5 text-left text-[13px] transition-colors",
                                selected
                                  ? "bg-surface/92 text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                                  : "text-text/88 hover:bg-surface/72",
                              ].join(" ")}
                              onClick={() => {
                                onSelectAiProfile(profile.id);
                                setModelMenuOpen(false);
                              }}
                              data-tauri-no-drag
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <ProviderIcon apiType={profile.apiType} className="h-7 w-7 shrink-0" />
                                <span className="min-w-0">
                                  <span className="block truncate">{profile.model}</span>
                                  <span className="block truncate text-[11px] text-muted">
                                    {provider.shortLabel}
                                  </span>
                                </span>
                              </span>
                              {selected ? (
                                <Check className="h-4 w-4 shrink-0 text-accent" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <div
                className={[
                  "inline-flex max-w-full items-center gap-1 rounded-full border px-1 py-0.5 text-[11px] shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]",
                  isAutoExecute
                    ? "border-warning/30 bg-warning/8 text-warning"
                    : "border-accent/20 bg-accent/7 text-accent",
                ].join(" ")}
              >
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (approvalMode !== "require_approval") {
                        onSaveApprovalMode("require_approval");
                      }
                    }}
                    className={[
                      "inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors",
                      !isAutoExecute
                        ? "bg-panel/95 text-accent shadow-sm"
                        : "text-muted hover:bg-surface/72",
                    ].join(" ")}
                    title={t("Approval")}
                    aria-label={t("Approval")}
                    data-tauri-no-drag
                  >
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (approvalMode !== "auto_execute") {
                        onSaveApprovalMode("auto_execute");
                      }
                    }}
                    className={[
                      "inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors",
                      isAutoExecute
                        ? "bg-panel/95 text-warning shadow-sm"
                        : "text-muted hover:bg-surface/72",
                    ].join(" ")}
                    title={t("Full Access")}
                    aria-label={t("Full Access")}
                    data-tauri-no-drag
                  >
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <button
                type={isStreaming ? "button" : "submit"}
                onClick={isStreaming ? onCancelStreaming : undefined}
                disabled={isStreaming ? false : !canSend}
                className={[
                  "inline-flex h-9 w-9 items-center justify-center rounded-[18px] text-white transition-all disabled:cursor-not-allowed disabled:opacity-45",
                  isStreaming
                    ? "border border-danger/70 bg-danger/85 shadow-[0_10px_24px_rgba(194,72,50,0.22)] hover:bg-danger"
                    : "border border-accent bg-[linear-gradient(135deg,rgba(28,122,103,0.96),rgba(43,148,126,0.92))] shadow-[0_14px_32px_rgba(28,122,103,0.28)] hover:-translate-y-px hover:shadow-[0_16px_34px_rgba(28,122,103,0.32)]",
                ].join(" ")}
                title={isStreaming ? t("Stop") : t("Send")}
                aria-label={isStreaming ? t("Stop") : t("Send")}
                data-tauri-no-drag
              >
                {isStreaming ? <X className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
