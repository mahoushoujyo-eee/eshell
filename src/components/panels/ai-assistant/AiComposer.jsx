import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Send, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { ShellContextChip } from "./AiAssistantControls";

export default function AiComposer({
  isDrawer,
  aiProfiles,
  activeAiProfileId,
  onSelectAiProfile,
  approvalMode,
  shellContext,
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
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const isAutoExecute = approvalMode === "auto_execute";
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
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minComposerHeight), maxComposerHeight);
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
      <div
        className={[
          "rounded-[26px] bg-transparent p-0 transition-all duration-200",
          "focus-within:bg-[radial-gradient(circle_at_center,rgba(28,122,103,0.05),transparent_68%)]",
        ].join(" ")}
      >
        <div className="relative overflow-visible rounded-[22px] border border-border/50 bg-[linear-gradient(180deg,rgba(252,250,245,0.56),rgba(247,244,237,0.82))] shadow-[inset_0_1px_0_rgba(255,255,255,0.42)]">
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
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/45 bg-transparent px-3 py-1.5">
            <div className="mr-auto flex min-w-0 flex-1 items-center">
              <div ref={modelPickerRef} className="relative min-w-0" data-tauri-no-drag>
                <button
                  type="button"
                  className="inline-flex min-w-0 max-w-[13rem] items-center gap-2 rounded-full border border-border/55 bg-[linear-gradient(180deg,rgba(255,255,255,0.76),rgba(242,238,230,0.92))] px-3 py-1.5 text-[12px] text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.62)] transition-all hover:border-accent/28 hover:bg-white/86"
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
                  <div className="absolute bottom-full left-0 z-30 mb-2 w-[16rem] overflow-hidden rounded-[22px] border border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,241,233,0.98))] shadow-[0_18px_42px_rgba(39,33,24,0.16)] backdrop-blur-xl">
                    <div className="px-4 pb-1 pt-3 text-[11px] font-medium tracking-[0.08em] text-muted">
                      {t("Model")}
                    </div>
                    <div className="max-h-72 overflow-auto px-2 pb-2">
                      {aiProfiles.map((profile) => {
                        const selected = profile.id === activeAiProfileId;
                        return (
                          <button
                            key={profile.id}
                            type="button"
                            className={[
                              "flex w-full items-center justify-between gap-3 rounded-[16px] px-3 py-2.5 text-left text-[13px] transition-colors",
                              selected
                                ? "bg-white/88 text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.68)]"
                                : "text-text/88 hover:bg-white/56",
                            ].join(" ")}
                            onClick={() => {
                              onSelectAiProfile(profile.id);
                              setModelMenuOpen(false);
                            }}
                            data-tauri-no-drag
                          >
                            <span className="truncate">{profile.model}</span>
                            {selected ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
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
                        ? "bg-white/88 text-accent shadow-sm"
                        : "text-muted hover:bg-white/44",
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
                        ? "bg-white/88 text-warning shadow-sm"
                        : "text-muted hover:bg-white/44",
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
                disabled={isStreaming ? false : !aiQuestion.trim()}
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
