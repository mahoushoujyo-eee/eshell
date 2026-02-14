import { ArrowLeft, Link2, Pencil, Plus, Save, Server, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

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
  const [mode, setMode] = useState("list");

  useEffect(() => {
    if (open) {
      setMode("list");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const submitSsh = async (event) => {
    await onSaveSsh(event);
    setMode("list");
  };

  const openCreateForm = () => {
    setSshForm(EMPTY_SSH_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setSshForm(item);
    setMode("form");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <Server className="h-4 w-4 text-accent" aria-hidden="true" />
              SSH Servers
            </h3>
            <p className="text-xs text-muted">Manage server profiles and connect quickly.</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Close
          </button>
        </div>

        {mode === "list" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">Configured: {sshConfigs.length}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={openCreateForm}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New Server
              </button>
            </div>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {sshConfigs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  No server profiles yet.
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
                        className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-white"
                        onClick={async () => {
                          await onConnectServer(item.id);
                          onClose();
                        }}
                      >
                        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Connect
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"
                        onClick={() => openEditForm(item)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-danger"
                        onClick={() => onDeleteSsh(item.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Delete
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
              <span className="text-sm text-muted">{sshForm.id ? "Edit server" : "New server"}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Back
              </button>
            </div>
            <form className="space-y-2" onSubmit={submitSsh}>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="Name"
                  value={sshForm.name}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, name: event.target.value }))}
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="Host"
                  value={sshForm.host}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, host: event.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="Port"
                  value={sshForm.port}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, port: event.target.value }))}
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="Username"
                  value={sshForm.username}
                  onChange={(event) => setSshForm((prev) => ({ ...prev, username: event.target.value }))}
                />
              </div>
              <input
                type="password"
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="Password"
                value={sshForm.password}
                onChange={(event) => setSshForm((prev) => ({ ...prev, password: event.target.value }))}
              />
              <div className="flex justify-end">
                <button type="submit" className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white">
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {sshForm.id ? "Update Server" : "Create Server"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
