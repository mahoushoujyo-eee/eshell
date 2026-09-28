import { ArrowLeft, Link2, LoaderCircle, Pencil, Plus, Save, Server, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import Button, { IconButton } from "../ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../ui/Dialog";
import SegmentedControl from "../ui/SegmentedControl";
import { inputClass, sectionLabelClass, selectClass } from "../ui/fieldClasses";

const EMPTY_SSH_FORM = {
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  privateKeyPath: "",
  privateKeyPassphrase: "",
  usePasswordFallback: false,
  jumpHostId: null,
  description: "",
};

/**
 * Marks a field the backend rejects when left empty.
 *
 * The form is placeholder-only and the dialog already fills most of the
 * viewport, so the marker sits inside the field instead of in a label above it:
 * that keeps the hint visible after the placeholder disappears without making
 * the dialog any taller. Inputs wrapped here need right padding so typed text
 * does not run under the marker.
 */
function RequiredField({ children }) {
  return (
    <div className="relative">
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm leading-none text-danger"
      >
        *
      </span>
    </div>
  );
}

export default function SshConfigModal({
  open,
  onClose,
  sshConfigs,
  sshForm,
  setSshForm,
  onSaveSsh,
  onConnectServer,
  onCancelConnectServer,
  onDeleteSsh,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("list");
  const [connectingId, setConnectingId] = useState("");
  const [connectingRequestId, setConnectingRequestId] = useState("");
  const [cancelingConnection, setCancelingConnection] = useState(false);

  useEffect(() => {
    if (open) {
      setMode("list");
      setConnectingId("");
      setConnectingRequestId("");
      setCancelingConnection(false);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const submitSsh = async (event) => {
    const saved = await onSaveSsh(event);
    if (saved) {
      setMode("list");
    }
  };

  const openCreateForm = () => {
    setSshForm(EMPTY_SSH_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setSshForm({
      ...EMPTY_SSH_FORM,
      ...item,
      authType: item.authType || "password",
    });
    setMode("form");
  };

  const handleConnect = async (configId) => {
    if (!configId || connectingId) {
      return;
    }

    const requestId =
      globalThis.crypto?.randomUUID?.() ||
      `connect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setConnectingId(configId);
    setConnectingRequestId(requestId);
    setCancelingConnection(false);
    try {
      const connected = await onConnectServer(configId, requestId);
      if (connected) {
        onClose();
      }
    } finally {
      setConnectingId("");
      setConnectingRequestId("");
      setCancelingConnection(false);
    }
  };

  const handleCancelConnect = async () => {
    if (!connectingRequestId || cancelingConnection) {
      return;
    }

    setCancelingConnection(true);
    const accepted = await onCancelConnectServer?.(connectingRequestId);
    if (!accepted) {
      setCancelingConnection(false);
    }
  };

  const isConnecting = Boolean(connectingId);
  const authType = sshForm.authType || "password";
  const authLabel = (type) =>
    type === "privateKey" ? t("Private key") : type === "keyboardInteractive" ? t("Keyboard Interactive") : t("Password");
  const setField = (key) => (event) => setSshForm((prev) => ({ ...prev, [key]: event.target.value }));

  return (
    <Dialog open={open} onClose={onClose} dismissible={!isConnecting} size="md" labelledBy="ssh-config-title">
      {mode === "list" ? (
        <>
          <DialogHeader
            icon={Server}
            tone="accent"
            title={t("Server Management")}
            titleId="ssh-config-title"
            actions={
              <Button variant="primary" onClick={openCreateForm} disabled={isConnecting}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("New Server")}
              </Button>
            }
            onClose={onClose}
            closeDisabled={isConnecting}
          />
          <DialogBody className="px-2 py-2">
            <div className="px-2 pt-1 pb-2 text-[11px] font-medium text-subtle">
              {t("Configured: {count}", { count: sshConfigs.length })}
            </div>
            {sshConfigs.length === 0 ? (
              <div className="mx-2 mb-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[13px] text-muted">
                {t("No server profiles yet.")}
              </div>
            ) : (
              <div className="space-y-0.5">
                {sshConfigs.map((item) => {
                  const connectingThis = connectingId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={[
                        "group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-150",
                        connectingThis ? "bg-accent-soft" : "hover:bg-hover",
                      ].join(" ")}
                    >
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-panel text-accent">
                        <Server className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-text">{item.name}</span>
                          <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted">
                            {authLabel(item.authType)}
                          </span>
                          {item.jumpHostId ? (
                            <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] leading-4 text-accent">
                              {t("via jump host")}
                            </span>
                          ) : null}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted">
                          {item.username}@{item.host}:{item.port}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <IconButton label={t("Edit")} onClick={() => openEditForm(item)} disabled={isConnecting}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </IconButton>
                          <IconButton
                            label={t("Delete")}
                            tone="danger"
                            onClick={() => onDeleteSsh(item.id)}
                            disabled={isConnecting}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </IconButton>
                        </div>
                        <Button
                          variant={connectingThis ? "danger" : "primary"}
                          className="ml-1 min-w-[76px]"
                          onClick={() => (connectingThis ? handleCancelConnect() : handleConnect(item.id))}
                          disabled={(isConnecting && !connectingThis) || cancelingConnection}
                        >
                          {connectingThis ? (
                            cancelingConnection ? (
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            )
                          ) : (
                            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {connectingThis
                            ? cancelingConnection
                              ? t("Cancelling...")
                              : t("Cancel")
                            : t("Connect")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
        </>
      ) : (
        <form className="flex min-h-0 flex-col" onSubmit={submitSsh}>
          <DialogHeader
            icon={sshForm.id ? Pencil : Plus}
            tone="accent"
            title={sshForm.id ? t("Edit server") : t("New server")}
            titleId="ssh-config-title"
            description={
              <span>
                <span aria-hidden="true" className="text-danger">
                  *
                </span>{" "}
                {t("Required")}
              </span>
            }
            actions={
              <Button variant="ghost" onClick={() => setMode("list")} disabled={isConnecting}>
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </Button>
            }
            onClose={onClose}
            closeDisabled={isConnecting}
          />
          <DialogBody className="space-y-4">
            <section className="space-y-2">
              <div className={sectionLabelClass}>{t("Server")}</div>
              <div className="grid grid-cols-2 gap-2">
                <RequiredField>
                  <input
                    className={`${inputClass} pr-6`}
                    placeholder={t("Name")}
                    aria-required="true"
                    value={sshForm.name}
                    onChange={setField("name")}
                  />
                </RequiredField>
                <RequiredField>
                  <input
                    className={`${inputClass} pr-6`}
                    placeholder={t("Host")}
                    aria-required="true"
                    value={sshForm.host}
                    onChange={setField("host")}
                  />
                </RequiredField>
              </div>
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <RequiredField>
                  <input
                    className={`${inputClass} pr-6`}
                    placeholder={t("Port")}
                    aria-required="true"
                    value={sshForm.port}
                    onChange={setField("port")}
                  />
                </RequiredField>
                <RequiredField>
                  <input
                    className={`${inputClass} pr-6`}
                    placeholder={t("Username")}
                    aria-required="true"
                    value={sshForm.username}
                    onChange={setField("username")}
                  />
                </RequiredField>
              </div>
              <input
                className={inputClass}
                placeholder={t("Description")}
                value={sshForm.description}
                onChange={setField("description")}
              />
            </section>

            <section className="space-y-2">
              <div className={sectionLabelClass}>{t("Authentication")}</div>
              <SegmentedControl
                size="sm"
                value={authType}
                onChange={(value) => setSshForm((prev) => ({ ...prev, authType: value }))}
                options={[
                  { id: "password", label: t("Password") },
                  { id: "privateKey", label: t("Private key") },
                  { id: "keyboardInteractive", label: t("2FA / KI") },
                ]}
              />
              {authType === "password" ? (
                <RequiredField>
                  <input
                    type="password"
                    className={`${inputClass} pr-6`}
                    placeholder={t("Password")}
                    aria-required="true"
                    value={sshForm.password}
                    onChange={setField("password")}
                  />
                </RequiredField>
              ) : authType === "keyboardInteractive" ? null : (
                <div className="space-y-2">
                  <RequiredField>
                    <input
                      className={`${inputClass} pr-6 font-mono text-xs`}
                      placeholder={t("Private key path")}
                      aria-required="true"
                      value={sshForm.privateKeyPath}
                      onChange={setField("privateKeyPath")}
                    />
                  </RequiredField>
                  <input
                    type="password"
                    className={inputClass}
                    placeholder={t("Private key passphrase (optional)")}
                    value={sshForm.privateKeyPassphrase}
                    onChange={setField("privateKeyPassphrase")}
                  />
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-accent"
                      checked={Boolean(sshForm.usePasswordFallback)}
                      onChange={(event) =>
                        setSshForm((prev) => ({ ...prev, usePasswordFallback: event.target.checked }))
                      }
                    />
                    {t("Use password fallback")}
                  </label>
                  {sshForm.usePasswordFallback ? (
                    <RequiredField>
                      <input
                        type="password"
                        className={`${inputClass} pr-6`}
                        placeholder={t("Fallback password")}
                        aria-required="true"
                        value={sshForm.password}
                        onChange={setField("password")}
                      />
                    </RequiredField>
                  ) : null}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className={sectionLabelClass}>{t("Jump Host (optional)")}</div>
              <select
                className={selectClass}
                value={sshForm.jumpHostId || ""}
                onChange={(event) => setSshForm((prev) => ({ ...prev, jumpHostId: event.target.value || null }))}
              >
                <option value="">{t("None (direct connection)")}</option>
                {(sshConfigs || [])
                  .filter((c) => c.id !== sshForm.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.username}@{c.host}:{c.port})
                    </option>
                  ))}
              </select>
            </section>
          </DialogBody>
          <DialogFooter>
            <Button type="submit" variant="primary">
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {sshForm.id ? t("Update Server") : t("Create Server")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
