import { ArrowLeft, Link2, LoaderCircle, Pencil, Plus, Save, Server, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";

const EMPTY_SSH_FORM = {
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  password: "",
  description: "",
};

export default function SshConfigModal({
  open,
  onClose,
  sshConfigs,
  sshForm,
  setSshForm,
  onSaveSsh,
  onConnectServer,
  onDeleteSsh,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("list");
  const [connectingId, setConnectingId] = useState("");

  useEffect(() => {
    if (open) {
      setMode("list");
      setConnectingId("");
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
    setSshForm(item);
    setMode("form");
  };

  const handleConnect = async (configId) => {
    if (!configId || connectingId) {
      return;
    }

    setConnectingId(configId);
    try {
      const connected = await onConnectServer(configId);
      if (connected) {
        onClose();
      }
    } finally {
      setConnectingId("");
    }
  };

  const isConnecting = Boolean(connectingId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={isConnecting ? undefined : onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <Server className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("SSH Servers")}
            </h3>
            <p className="text-xs text-muted">{t("Manage server profiles and connect quickly.")}</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft disabled:opacity-60"
            onClick={onClose}
            disabled={isConnecting}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Close")}
          </button>
        </div>

        {mode === "list" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {t("Configured: {count}", { count: sshConfigs.length })}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-wait disabled:opacity-70"
                onClick={openCreateForm}
                disabled={isConnecting}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("New Server")}
              </button>
            </div>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {sshConfigs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  {t("No server profiles yet.")}
                </div>
              ) : (
                sshConfigs.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs">
                    <div className="font-medium">{item.name}</div>
                    <div className="text-muted">
                      {item.username}@{item.host}:{item.port}
                    </div>
                    <div className="mt-2 flex gap-1">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-white disabled:cursor-wait disabled:opacity-70"
                        onClick={() => handleConnect(item.id)}
                        disabled={isConnecting}
                      >
                        {connectingId === item.id ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {connectingId === item.id ? t("Connecting...") : t("Connect")}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 disabled:opacity-60"
                        onClick={() => openEditForm(item)}
                        disabled={isConnecting}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("Edit")}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-danger disabled:opacity-60"
                        onClick={() => onDeleteSsh(item.id)}
                        disabled={isConnecting}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("Delete")}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {sshForm.id ? t("Edit server") : t("New server")}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs disabled:opacity-60"
                onClick={() => setMode("list")}
                disabled={isConnecting}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </button>
            </div>
            <form className="space-y-2" onSubmit={submitSsh}>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("Name")}
                  value={sshForm.name}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, name: event.target.value }))}
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("Host")}
                  value={sshForm.host}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, host: event.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("Port")}
                  value={sshForm.port}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, port: event.target.value }))}
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("Username")}
                  value={sshForm.username}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, username: event.target.value }))}
                />
              </div>
              <input
                type="password"
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder={t("Password")}
                value={sshForm.password}
                onChange={(event) => setSshForm((prev) => ({ ...prev, password: event.target.value }))}
              />
              <div className="flex justify-end">
                <button type="submit" className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white">
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {sshForm.id ? t("Update Server") : t("Create Server")}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
