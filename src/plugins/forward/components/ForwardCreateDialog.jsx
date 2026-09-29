import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Waypoints } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import Button from "../../../components/ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../../../components/ui/Dialog";
import { inputClass } from "../../../components/ui/fieldClasses";

/** Ports are 1-65535; 0 is only meaningful as "let the OS pick" on the bind side. */
const parsePort = (value) => {
  const trimmed = String(value ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
};

/**
 * "New forward" form.
 *
 * The bind side defaults to loopback on purpose: `0.0.0.0` publishes the
 * remote service to the whole local network, which is the classic `-L`
 * footgun, so it is an explicit choice rather than the default.
 */
export default function ForwardCreateDialog({ open, busy = false, onCancel, onConfirm }) {
  const { t } = useI18n();
  const [targetHost, setTargetHost] = useState("localhost");
  const [targetPort, setTargetPort] = useState("");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("");
  const targetPortRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTargetHost("localhost");
    setTargetPort("");
    setBindHost("127.0.0.1");
    setBindPort("");
    window.setTimeout(() => targetPortRef.current?.focus(), 0);
  }, [open]);

  const parsedTargetPort = parsePort(targetPort);
  const parsedBindPort = bindPort.trim() === "" ? 0 : parsePort(bindPort);
  const targetPortInvalid = targetPort.trim() !== "" && parsedTargetPort === null;
  const bindPortInvalid = bindPort.trim() !== "" && parsedBindPort === null;
  const canSubmit =
    !busy && targetHost.trim() !== "" && parsedTargetPort !== null && !bindPortInvalid;

  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    onConfirm?.({
      targetHost: targetHost.trim(),
      targetPort: parsedTargetPort,
      bindHost: bindHost.trim() || "127.0.0.1",
      bindPort: parsedBindPort ?? 0,
    });
  };

  const summary = useMemo(() => {
    const local = `${bindHost.trim() || "127.0.0.1"}:${bindPort.trim() || "auto"}`;
    const remote = `${targetHost.trim() || "?"}:${targetPort.trim() || "?"}`;
    return `${local}  →  ${remote}`;
  }, [bindHost, bindPort, targetHost, targetPort]);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      dismissible={!busy}
      layer="stacked"
      size="sm"
      labelledBy="forward-create-title"
    >
      <form className="flex min-h-0 flex-col" onSubmit={submit}>
        <DialogHeader
          icon={Waypoints}
          tone="accent"
          title={t("New port forward")}
          titleId="forward-create-title"
          onClose={onCancel}
          closeDisabled={busy}
        />
        <DialogBody>
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted">{t("Target host")}</span>
                <input
                  className={inputClass}
                  value={targetHost}
                  onChange={(event) => setTargetHost(event.target.value)}
                  placeholder="localhost"
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted">{t("Port")}</span>
                <input
                  ref={targetPortRef}
                  className={[
                    inputClass,
                    targetPortInvalid ? "border-danger focus:border-danger focus:ring-danger/20" : "",
                  ].join(" ")}
                  value={targetPort}
                  onChange={(event) => setTargetPort(event.target.value)}
                  placeholder="5432"
                  inputMode="numeric"
                  aria-invalid={targetPortInvalid}
                  disabled={busy}
                />
              </label>
            </div>

            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted">{t("Listen address")}</span>
                <input
                  className={inputClass}
                  value={bindHost}
                  onChange={(event) => setBindHost(event.target.value)}
                  placeholder="127.0.0.1"
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted">{t("Port")}</span>
                <input
                  className={[
                    inputClass,
                    bindPortInvalid ? "border-danger focus:border-danger focus:ring-danger/20" : "",
                  ].join(" ")}
                  value={bindPort}
                  onChange={(event) => setBindPort(event.target.value)}
                  placeholder={t("Auto")}
                  inputMode="numeric"
                  aria-invalid={bindPortInvalid}
                  disabled={busy}
                />
              </label>
            </div>

            <div className="min-h-4 text-[11px]">
              {targetPortInvalid || bindPortInvalid ? (
                <span className="text-danger">{t("Ports must be 1-65535.")}</span>
              ) : (
                <span className="font-mono text-muted">{summary}</span>
              )}
            </div>

            <p className="text-[11px] leading-relaxed text-muted">
              {t("The target is resolved by the server, not by this machine.")}
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {busy ? t("Starting...") : t("Start")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
