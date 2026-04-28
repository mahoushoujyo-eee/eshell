import {
  ArrowLeft,
  FileText,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";

const EMPTY_SCRIPT_FORM = {
  id: null,
  name: "",
  path: "",
  command: "",
  description: "",
  parameters: [],
};

const EMPTY_PARAMETER = {
  name: "",
  label: "",
  defaultValue: "",
  required: false,
  quote: true,
};

const normalizeScriptForm = (script) => ({
  ...EMPTY_SCRIPT_FORM,
  ...script,
  parameters: Array.isArray(script?.parameters)
    ? script.parameters.map((parameter) => ({
        ...EMPTY_PARAMETER,
        ...parameter,
        name: parameter?.name || "",
        label: parameter?.label || "",
        defaultValue: parameter?.defaultValue || "",
        required: Boolean(parameter?.required),
        quote: parameter?.quote !== false,
      }))
    : [],
});

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
  const { t } = useI18n();
  const [mode, setMode] = useState("list");
  const [runScriptTarget, setRunScriptTarget] = useState(null);
  const [runParameterValues, setRunParameterValues] = useState({});

  useEffect(() => {
    if (open) {
      setMode("list");
      setRunScriptTarget(null);
      setRunParameterValues({});
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
    setScriptForm(normalizeScriptForm(item));
    setMode("form");
  };

  const updateParameter = (index, patch) => {
    setScriptForm((prev) => {
      const parameters = Array.isArray(prev.parameters) ? [...prev.parameters] : [];
      parameters[index] = {
        ...EMPTY_PARAMETER,
        ...parameters[index],
        ...patch,
      };
      return { ...prev, parameters };
    });
  };

  const addParameter = () => {
    setScriptForm((prev) => ({
      ...prev,
      parameters: [...(Array.isArray(prev.parameters) ? prev.parameters : []), EMPTY_PARAMETER],
    }));
  };

  const removeParameter = (index) => {
    setScriptForm((prev) => ({
      ...prev,
      parameters: (Array.isArray(prev.parameters) ? prev.parameters : []).filter(
        (_item, itemIndex) => itemIndex !== index,
      ),
    }));
  };

  const openRunForm = (script) => {
    const parameters = Array.isArray(script.parameters) ? script.parameters : [];
    if (parameters.length === 0) {
      onRunScript(script.id);
      return;
    }

    setRunScriptTarget(script);
    setRunParameterValues(
      Object.fromEntries(
        parameters.map((parameter) => [
          parameter.name,
          parameter.defaultValue || "",
        ]),
      ),
    );
    setMode("run");
  };

  const submitRun = async (event) => {
    event.preventDefault();
    if (!runScriptTarget) {
      return;
    }
    const didRun = await onRunScript(runScriptTarget.id, runParameterValues);
    if (!didRun) {
      return;
    }
    setMode("list");
    setRunScriptTarget(null);
    setRunParameterValues({});
  };

  const formParameters = Array.isArray(scriptForm.parameters)
    ? scriptForm.parameters
    : [];
  const runParameters = Array.isArray(runScriptTarget?.parameters)
    ? runScriptTarget.parameters
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("Scripts")}
            </h3>
            <p className="text-xs text-muted">
              {t("Manage scripts as callable functions with parameters.")}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Close")}
          </button>
        </div>

        {mode === "list" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {t("Configured: {count}", { count: scripts.length })}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={openCreateForm}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("New Script")}
              </button>
            </div>
            <div className="max-h-[58vh] space-y-2 overflow-auto pr-1">
              {scripts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  {t("No scripts yet.")}
                </div>
              ) : (
                scripts.map((item) => {
                  const parameterCount = Array.isArray(item.parameters)
                    ? item.parameters.length
                    : 0;
                  return (
                    <div key={item.id} className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium">{item.name}</div>
                          <div className="mt-0.5 truncate text-muted">{item.command || item.path}</div>
                        </div>
                        <span className="shrink-0 rounded-full border border-border/80 bg-panel px-2 py-0.5 text-[10px] text-muted">
                          {t("Parameters: {count}", { count: parameterCount })}
                        </span>
                      </div>
                      <div className="mt-2 flex gap-1">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-white"
                          onClick={() => openRunForm(item)}
                        >
                          <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          {parameterCount > 0 ? t("Run With Parameters") : t("Run")}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"
                          onClick={() => openEditForm(item)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("Edit")}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-danger"
                          onClick={() => onDeleteScript(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("Delete")}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : mode === "run" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="min-w-0 truncate text-sm text-muted">
                {t("Run script")}: {runScriptTarget?.name}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </button>
            </div>

            <form className="space-y-3" onSubmit={submitRun}>
              <div className="rounded-lg border border-border/70 bg-surface p-3">
                <div className="mb-2 text-xs font-medium">{t("Script Parameters")}</div>
                <div className="space-y-2">
                  {runParameters.map((parameter) => (
                    <label key={parameter.name} className="block">
                      <span className="mb-1 block text-xs text-muted">
                        {parameter.label || parameter.name}
                        {parameter.required ? " *" : ""}
                      </span>
                      <input
                        className="w-full rounded border border-border bg-panel px-2 py-1.5 text-sm"
                        value={runParameterValues[parameter.name] || ""}
                        required={Boolean(parameter.required)}
                        onChange={(event) =>
                          setRunParameterValues((prev) => ({
                            ...prev,
                            [parameter.name]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("Run")}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">
                {scriptForm.id ? t("Edit script") : t("New script")}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Back")}
              </button>
            </div>
            <form className="max-h-[64vh] space-y-3 overflow-auto pr-1" onSubmit={submitScript}>
              <section className="space-y-2 rounded-lg border border-border/70 bg-surface p-3">
                <input
                  className="w-full rounded border border-border bg-panel px-2 py-1.5 text-sm"
                  placeholder={t("Script name")}
                  value={scriptForm.name}
                  onChange={(event) => setScriptForm((prev) => ({ ...prev, name: event.target.value }))}
                />
                <input
                  className="w-full rounded border border-border bg-panel px-2 py-1.5 text-sm"
                  placeholder={t("Script path")}
                  value={scriptForm.path}
                  onChange={(event) => setScriptForm((prev) => ({ ...prev, path: event.target.value }))}
                />
                <input
                  className="w-full rounded border border-border bg-panel px-2 py-1.5 text-sm"
                  placeholder={t("Run command")}
                  value={scriptForm.command}
                  onChange={(event) => setScriptForm((prev) => ({ ...prev, command: event.target.value }))}
                />
                <textarea
                  className="h-20 w-full resize-none rounded border border-border bg-panel px-2 py-1.5 text-sm"
                  placeholder={t("Description")}
                  value={scriptForm.description}
                  onChange={(event) => setScriptForm((prev) => ({ ...prev, description: event.target.value }))}
                />
              </section>

              <section className="rounded-lg border border-border/70 bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{t("Script Parameters")}</div>
                    <div className="text-[11px] text-muted">
                      {t("Use placeholders like {{name}} in the command, or parameters are appended in order.")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                    onClick={addParameter}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("Add Parameter")}
                  </button>
                </div>

                {formParameters.length === 0 ? (
                  <div className="rounded border border-dashed border-border/80 bg-panel px-3 py-3 text-center text-xs text-muted">
                    {t("No parameters yet.")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {formParameters.map((parameter, index) => (
                      <div key={index} className="rounded border border-border/70 bg-panel p-2">
                        <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                          <input
                            className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                            placeholder={t("Parameter name")}
                            value={parameter.name}
                            onChange={(event) => updateParameter(index, { name: event.target.value })}
                          />
                          <input
                            className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                            placeholder={t("Parameter label")}
                            value={parameter.label}
                            onChange={(event) => updateParameter(index, { label: event.target.value })}
                          />
                          <input
                            className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                            placeholder={t("Default value")}
                            value={parameter.defaultValue}
                            onChange={(event) => updateParameter(index, { defaultValue: event.target.value })}
                          />
                          <button
                            type="button"
                            className="inline-flex items-center justify-center gap-1 rounded border border-danger/40 px-2 py-1 text-xs text-danger"
                            onClick={() => removeParameter(index)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            {t("Delete")}
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
                          <label className="inline-flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={Boolean(parameter.required)}
                              onChange={(event) => updateParameter(index, { required: event.target.checked })}
                            />
                            {t("Required")}
                          </label>
                          <label className="inline-flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={parameter.quote !== false}
                              onChange={(event) => updateParameter(index, { quote: event.target.checked })}
                            />
                            {t("Shell quote")}
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {scriptForm.id ? t("Update Script") : t("Create Script")}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
