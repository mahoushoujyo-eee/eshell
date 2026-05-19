import { useEffect, useRef, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";

export default function SshKiPromptDialog({ prompt, onDismiss }) {
  const { t } = useI18n();
  const [responses, setResponses] = useState([]);
  const [busy, setBusy] = useState(false);
  const firstInputRef = useRef(null);

  useEffect(() => {
    if (!prompt) {
      return;
    }
    setResponses((prompt.prompts || []).map(() => ""));
    setBusy(false);
    setTimeout(() => {
      firstInputRef.current?.focus();
    }, 50);
  }, [prompt]);

  if (!prompt) {
    return null;
  }

  const handleChange = (index, value) => {
    setResponses((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await api.sshKiRespond(prompt.requestId, responses);
      onDismiss?.();
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await api.sshKiRespond(prompt.requestId, (prompt.prompts || []).map(() => ""));
    } finally {
      onDismiss?.();
    }
  };

  const title = prompt.name || t("Keyboard Interactive Auth");
  const instructions = prompt.instructions || "";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-md rounded-2xl border border-border/80 bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <div>
              <div className="text-sm font-semibold">{title}</div>
              {prompt.username && (
                <div className="text-xs text-muted">
                  {t("User")}: {prompt.username}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft disabled:opacity-60"
            onClick={handleCancel}
            disabled={busy}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {instructions && (
          <p className="mb-4 rounded border border-border/50 bg-surface/60 px-3 py-2 text-xs text-muted whitespace-pre-wrap">
            {instructions}
          </p>
        )}

        <form className="space-y-3" onSubmit={handleSubmit}>
          {(prompt.prompts || []).map((item, index) => (
            <div key={index}>
              {item.text && (
                <label className="mb-1 block text-xs font-medium text-muted">
                  {item.text}
                </label>
              )}
              <input
                ref={index === 0 ? firstInputRef : undefined}
                type={item.echo ? "text" : "password"}
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                value={responses[index] || ""}
                onChange={(e) => handleChange(index, e.target.value)}
                autoComplete={item.echo ? "off" : "current-password"}
                disabled={busy}
              />
            </div>
          ))}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="inline-flex items-center rounded border border-border px-3 py-1.5 text-xs disabled:opacity-60"
              onClick={handleCancel}
              disabled={busy}
            >
              {t("Cancel")}
            </button>
            <button
              type="submit"
              className="inline-flex items-center rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-70"
              disabled={busy}
            >
              {busy ? t("Sending...") : t("Confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
