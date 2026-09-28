import {
  ArrowLeft,
  FileText,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import Button, { IconButton } from "../ui/Button";
import Dialog, { DialogBody, DialogFooter, DialogHeader } from "../ui/Dialog";
import { inputClass, inputSmClass, labelClass, sectionLabelClass, textareaClass } from "../ui/fieldClasses";

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

  const backButton = (
    <Button variant="ghost" onClick={() => setMode("list")}>
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      {t("Back")}
    </Button>
  );

  return (
    <Dialog open={open} onClose={onClose} size="lg" labelledBy="script-config-title">
      {mode === "list" ? (
        <>
          <DialogHeader
            icon={FileText}
            tone="accent"
            title={t("Scripts")}
            titleId="script-config-title"
            actions={
              <Button variant="primary" onClick={openCreateForm}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("New Script")}
              </Button>
            }
            onClose={onClose}
          />
          <DialogBody className="px-2 py-2">
            <div className="px-2 pt-1 pb-2 text-[11px] font-medium text-subtle">
              {t("Configured: {count}", { count: scripts.length })}
            </div>
            {scripts.length === 0 ? (
              <div className="mx-2 mb-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-[13px] text-muted">
                {t("No scripts yet.")}
              </div>
            ) : (
              <div className="space-y-0.5">
                {scripts.map((item) => {
                  const parameterCount = Array.isArray(item.parameters) ? item.parameters.length : 0;
                  return (
                    <div
                      key={item.id}
                      className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-150 hover:bg-hover"
                    >
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-panel text-info">
                        <FileText className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-text">{item.name}</span>
                          <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted">
                            {t("Parameters: {count}", { count: parameterCount })}
                          </span>
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted">{item.command || item.path}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <IconButton label={t("Edit")} onClick={() => openEditForm(item)}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </IconButton>
                          <IconButton label={t("Delete")} tone="danger" onClick={() => onDeleteScript(item.id)}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </IconButton>
                        </div>
                        <Button variant="primary" className="ml-1" onClick={() => openRunForm(item)}>
                          <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          {parameterCount > 0 ? t("Run With Parameters") : t("Run")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
        </>
      ) : mode === "run" ? (
        <form className="flex min-h-0 flex-col" onSubmit={submitRun}>
          <DialogHeader
            icon={Play}
            tone="accent"
            title={`${t("Run script")}: ${runScriptTarget?.name || ""}`}
            titleId="script-config-title"
            actions={backButton}
            onClose={onClose}
          />
          <DialogBody className="space-y-3">
            <div className={sectionLabelClass}>{t("Script Parameters")}</div>
            {runParameters.map((parameter) => (
              <label key={parameter.name} className="block space-y-1">
                <span className={labelClass}>
                  {parameter.label || parameter.name}
                  {parameter.required ? <span className="text-danger"> *</span> : ""}
                </span>
                <input
                  className={inputClass}
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
          </DialogBody>
          <DialogFooter>
            <Button type="submit" variant="primary">
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {t("Run")}
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <form className="flex min-h-0 flex-col" onSubmit={submitScript}>
          <DialogHeader
            icon={scriptForm.id ? Pencil : Plus}
            tone="accent"
            title={scriptForm.id ? t("Edit script") : t("New script")}
            titleId="script-config-title"
            actions={backButton}
            onClose={onClose}
          />
          <DialogBody className="space-y-5">
            <section className="space-y-2">
              <input
                className={inputClass}
                placeholder={t("Script name")}
                value={scriptForm.name}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, name: event.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={`${inputClass} font-mono text-xs`}
                  placeholder={t("Script path")}
                  value={scriptForm.path}
                  onChange={(event) => setScriptForm((prev) => ({ ...prev, path: event.target.value }))}
                />
                <input
                  className={`${inputClass} font-mono text-xs`}
                  placeholder={t("Run command")}
                  value={scriptForm.command}
                  onChange={(event) => setScriptForm((prev) => ({ ...prev, command: event.target.value }))}
                />
              </div>
              <textarea
                className={`${textareaClass} h-20 resize-none`}
                placeholder={t("Description")}
                value={scriptForm.description}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, description: event.target.value }))}
              />
            </section>

            <section className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={sectionLabelClass}>{t("Script Parameters")}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-muted">
                    {t("Use placeholders like {{name}} in the command, or parameters are appended in order.")}
                  </div>
                </div>
                <Button variant="secondary" onClick={addParameter}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("Add Parameter")}
                </Button>
              </div>

              {formParameters.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-xs text-muted">
                  {t("No parameters yet.")}
                </div>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {formParameters.map((parameter, index) => (
                    <div key={index} className="space-y-2 p-2.5">
                      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                        <input
                          className={inputSmClass}
                          placeholder={t("Parameter name")}
                          value={parameter.name}
                          onChange={(event) => updateParameter(index, { name: event.target.value })}
                        />
                        <input
                          className={inputSmClass}
                          placeholder={t("Parameter label")}
                          value={parameter.label}
                          onChange={(event) => updateParameter(index, { label: event.target.value })}
                        />
                        <input
                          className={inputSmClass}
                          placeholder={t("Default value")}
                          value={parameter.defaultValue}
                          onChange={(event) => updateParameter(index, { defaultValue: event.target.value })}
                        />
                        <IconButton label={t("Delete")} tone="danger" onClick={() => removeParameter(index)}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </IconButton>
                      </div>
                      <div className="flex flex-wrap gap-4 text-xs text-muted">
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-accent"
                            checked={Boolean(parameter.required)}
                            onChange={(event) => updateParameter(index, { required: event.target.checked })}
                          />
                          {t("Required")}
                        </label>
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-accent"
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
          </DialogBody>
          <DialogFooter>
            <Button type="submit" variant="primary">
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {scriptForm.id ? t("Update Script") : t("Create Script")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
