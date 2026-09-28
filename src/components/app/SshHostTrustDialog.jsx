import { AlertTriangle, Fingerprint, KeyRound, Server, ShieldCheck } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import Button from "../ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../ui/Dialog";

export default function SshHostTrustDialog({ challenge, onResolve }) {
  const { t } = useI18n();

  const isChanged = Boolean(challenge?.isChanged || challenge?.reason === "changed");
  const actionLabel = isChanged ? t("Update trusted key") : t("Trust and connect");
  const title = isChanged ? t("SSH host fingerprint changed") : t("Trust new SSH host?");

  return (
    <Dialog
      open={Boolean(challenge)}
      onClose={() => onResolve(false)}
      closeOnOverlay={false}
      layer="critical"
      size="md"
      labelledBy="ssh-host-trust-title"
    >
      {challenge ? (
        <>
          <DialogHeader
            icon={isChanged ? AlertTriangle : ShieldCheck}
            tone={isChanged ? "danger" : "accent"}
            title={title}
            titleId="ssh-host-trust-title"
            description={
              isChanged
                ? t("Only continue if you expected this server key to change.")
                : t("This host is not in your trusted SSH host list yet.")
            }
            onClose={() => onResolve(false)}
          />

          <DialogBody className="space-y-3">
            <div className="grid grid-cols-2 divide-x divide-border rounded-lg border border-border bg-panel">
              <div className="min-w-0 px-3 py-2">
                <div className="mb-0.5 inline-flex items-center gap-1.5 text-[11px] text-subtle">
                  <Server className="h-3 w-3" aria-hidden="true" />
                  {t("Host")}
                </div>
                <div className="truncate font-mono text-xs text-text">
                  {challenge.host}:{challenge.port || 22}
                </div>
              </div>
              <div className="min-w-0 px-3 py-2">
                <div className="mb-0.5 inline-flex items-center gap-1.5 text-[11px] text-subtle">
                  <KeyRound className="h-3 w-3" aria-hidden="true" />
                  {t("Key type")}
                </div>
                <div className="truncate font-mono text-xs text-text">{challenge.keyType || t("Unknown")}</div>
              </div>
            </div>

            {isChanged && challenge.trustedFingerprint ? (
              <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2">
                <div className="mb-1 text-[11px] font-medium text-danger">{t("Trusted fingerprint")}</div>
                <code className="font-mono text-xs break-all text-text">{challenge.trustedFingerprint}</code>
              </div>
            ) : null}

            <div className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-2">
              <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-accent">
                <Fingerprint className="h-3 w-3" aria-hidden="true" />
                {isChanged ? t("Presented fingerprint") : t("Fingerprint")}
              </div>
              <code className="block font-mono text-xs break-all text-text">{challenge.fingerprint}</code>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onResolve(false)}>
              {t("Cancel")}
            </Button>
            <Button variant={isChanged ? "danger" : "primary"} onClick={() => onResolve(true)}>
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {actionLabel}
            </Button>
          </DialogFooter>
        </>
      ) : null}
    </Dialog>
  );
}
