import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";
import Button from "../ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../ui/Dialog";
import { inputClass, labelClass } from "../ui/fieldClasses";

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

  const title = prompt?.name || t("Keyboard Interactive Auth");
  const instructions = prompt?.instructions || "";

  return (
    <Dialog open={Boolean(prompt)} onClose={handleCancel} dismissible={false} layer="stacked" size="sm">
      {prompt ? (
        <form className="flex min-h-0 flex-col" onSubmit={handleSubmit}>
          <DialogHeader
            icon={KeyRound}
            tone="accent"
            title={title}
            description={prompt.username ? `${t("User")}: ${prompt.username}` : null}
            onClose={handleCancel}
            closeDisabled={busy}
          />
          <DialogBody className="space-y-3">
            {instructions ? (
              <p className="rounded-md border border-border bg-panel px-3 py-2 text-xs whitespace-pre-wrap text-muted">
                {instructions}
              </p>
            ) : null}
            {(prompt.prompts || []).map((item, index) => (
              <div key={index} className="space-y-1">
                {item.text ? <label className={`block ${labelClass}`}>{item.text}</label> : null}
                <input
                  ref={index === 0 ? firstInputRef : undefined}
                  type={item.echo ? "text" : "password"}
                  className={inputClass}
                  value={responses[index] || ""}
                  onChange={(e) => handleChange(index, e.target.value)}
                  autoComplete={item.echo ? "off" : "current-password"}
                  disabled={busy}
                />
              </div>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={handleCancel} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t("Sending...") : t("Confirm")}
            </Button>
          </DialogFooter>
        </form>
      ) : null}
    </Dialog>
  );
}
