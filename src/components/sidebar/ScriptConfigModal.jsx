import { ArrowLeft, FileText, Pencil, Play, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

const EMPTY_SCRIPT_FORM = {
  id: null,
  name: "",
  path: "",
  command: "",
  description: "",
};

export default function ScriptConfigModal({
  open,
  onClose,
  scripts,
  scriptForm,
  setScriptForm,
  onSaveScript,
  onRunScript,
  onDeleteScript,
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

  const submitScript = async (event) => {
    await onSaveScript(event);
    setMode("list");
  };

  const openCreateForm = () => {
    setScriptForm(EMPTY_SCRIPT_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setScriptForm(item);
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
              <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
              Scripts
            </h3>
            <p className="text-xs text-muted">Manage scripts and execute them in the active SSH session.</p>
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
              <span className="text-sm text-muted">Configured: {scripts.length}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={openCreateForm}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New Script
              </button>
            </div>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {scripts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  No scripts yet.
                </div>
              ) : (
                scripts.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs">
                    <div className="font-medium">{item.name}</div>
                    <div className="truncate text-muted">{item.command || item.path}</div>
                    <div className="mt-2 flex gap-1">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-white"
                        onClick={() => onRunScript(item.id)}
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        Run
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
                        onClick={() => onDeleteScript(item.id)}
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
              <span className="text-sm text-muted">{scriptForm.id ? "Edit script" : "New script"}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Back
              </button>
            </div>
            <form className="space-y-2" onSubmit={submitScript}>
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="Script name"
                value={scriptForm.name}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, name: event.target.value }))}
              />
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="Script path"
                value={scriptForm.path}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, path: event.target.value }))}
              />
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="Run command"
                value={scriptForm.command}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, command: event.target.value }))}
              />
              <div className="flex justify-end">
                <button type="submit" className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white">
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {scriptForm.id ? "Update Script" : "Create Script"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
