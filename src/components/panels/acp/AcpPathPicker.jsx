import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, Loader2, Plus } from "lucide-react";
import { useI18n } from "../../../lib/i18n";
import { cx } from "../../ui/cx";

/**
 * Where a new conversation should run, chosen before picking the agent.
 *
 * The starter screen used to open every conversation in the agent's own
 * configured directory, with no way to say otherwise — the project registry was
 * only reachable through the history panel after a conversation already
 * existed. This is that choice, next to the title.
 *
 * `value` is `null` for "the agent's own directory", or a project row
 * (`{ id, name, path }`). The whole row is kept rather than just the id so the
 * trigger still spells out the name if the project is unregistered later.
 */
export default function AcpPathPicker({ projects, value, defaultHint, onChange, onAddProject }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef(null);

  // Dismiss on outside click or Escape. Escape is captured so it closes the
  // menu instead of bubbling to App's "close the dock" handler.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const label = value?.name || t("Default path");
  const title = value?.path || defaultHint || t("Each agent's own directory");

  const createProject = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const project = await onAddProject?.();
      if (project) {
        onChange(project);
        setOpen(false);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        className={cx(
          "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors duration-150",
          open
            ? "border-border-strong bg-hover text-text"
            : "border-border-strong text-text hover:bg-hover",
        )}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 max-w-[10rem] truncate">{label}</span>
        <ChevronDown
          className={cx(
            "h-3.5 w-3.5 shrink-0 text-muted transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-overlay"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value == null}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            title={defaultHint || t("Each agent's own directory")}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
          >
            <span className="mt-0.5 shrink-0">
              <Folder className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-text">
                {t("Default path")}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
                {defaultHint || t("Each agent's own directory")}
              </span>
            </span>
            {value == null ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            ) : null}
          </button>

          {projects.map((project) => {
            const selected = project.id === value?.id;
            return (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(project);
                  setOpen(false);
                }}
                title={project.path}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
              >
                <span className="mt-0.5 shrink-0">
                  <Folder className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-text">
                    {project.name}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
                    {project.path}
                  </span>
                </span>
                {selected ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            onClick={() => void createProject()}
            disabled={creating}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text transition-colors hover:bg-hover disabled:opacity-55"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" aria-hidden="true" />
            ) : (
              <Plus className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            )}
            {t("New project")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
