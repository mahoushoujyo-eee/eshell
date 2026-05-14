import { AlertTriangle, Fingerprint, KeyRound, Server, ShieldCheck, X } from "lucide-react";
import { useEffect } from "react";
import { useI18n } from "../../lib/i18n";

export default function SshHostTrustDialog({ challenge, onResolve }) {
  const { t } = useI18n();

  useEffect(() => {
    if (!challenge) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onResolve(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [challenge, onResolve]);

  if (!challenge) {
    return null;
  }

  const isChanged = Boolean(challenge.isChanged || challenge.reason === "changed");
  const actionLabel = isChanged ? t("Update trusted key") : t("Trust and connect");
  const title = isChanged ? t("SSH host fingerprint changed") : t("Trust new SSH host?");

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <section
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border/80 bg-panel shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-host-trust-title"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={[
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                isChanged
                  ? "border-danger/30 bg-danger/10 text-danger"
                  : "border-accent/30 bg-accent-soft text-accent",
              ].join(" ")}
            >
              {isChanged ? (
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0">
              <h3 id="ssh-host-trust-title" className="text-base font-semibold text-text">
                {title}
              </h3>
              <p className="mt-1 text-xs text-muted">
                {isChanged
                  ? t("Only continue if you expected this server key to change.")
                  : t("This host is not in your trusted SSH host list yet.")}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-md border border-border p-1.5 text-muted hover:bg-accent-soft hover:text-text"
            onClick={() => onResolve(false)}
            aria-label={t("Cancel")}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-4 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border/70 bg-surface px-3 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted">
                <Server className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Host")}
              </div>
              <div className="truncate font-medium">
                {challenge.host}:{challenge.port || 22}
              </div>
            </div>
            <div className="rounded-lg border border-border/70 bg-surface px-3 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted">
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Key type")}
              </div>
              <div className="truncate font-medium">{challenge.keyType || t("Unknown")}</div>
            </div>
          </div>

          {isChanged && challenge.trustedFingerprint ? (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
              <div className="mb-1 text-xs font-medium text-danger">{t("Trusted fingerprint")}</div>
              <code className="break-all text-xs text-text">{challenge.trustedFingerprint}</code>
            </div>
          ) : null}

          <div className="rounded-lg border border-accent/30 bg-accent-soft/60 px-3 py-2">
            <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              <Fingerprint className="h-3.5 w-3.5" aria-hidden="true" />
              {isChanged ? t("Presented fingerprint") : t("Fingerprint")}
            </div>
            <code className="break-all text-xs text-text">{challenge.fingerprint}</code>
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border bg-surface px-4 py-3">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:bg-panel"
            onClick={() => onResolve(false)}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            className={[
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white",
              isChanged ? "bg-danger" : "bg-accent",
            ].join(" ")}
            onClick={() => onResolve(true)}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            {actionLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
