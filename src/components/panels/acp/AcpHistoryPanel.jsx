import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import AcpAgentMenu from "./AcpAgentMenu";
import { useI18n } from "../../../lib/i18n";

/**
 * Past conversations, grouped by project.
 *
 * This used to be a mode that replaced the whole transcript area: opening one
 * meant leaving the conversation, and resuming was only possible with every
 * agent process stopped. It is now an overlay over the live conversation, and
 * picking a record opens it as another tab — which is also why nothing here
 * blocks on the current session's state.
 */

// Relative timestamps for the browser rows ("just now" / "11 min" / "3 d").
function formatRelativeTime(iso, t) {
  const then = Date.parse(iso || "");
  if (Number.isNaN(then)) {
    return "";
  }
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) {
    return t("just now");
  }
  if (minutes < 60) {
    return t("{count} min", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("{count} h", { count: hours });
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return t("{count} d", { count: days });
  }
  return (iso || "").slice(0, 10);
}

function HistoryRow({ row, open, onOpen, onDelete }) {
  const { t } = useI18n();
  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-hover">
      <button
        type="button"
        onClick={() => onOpen(row)}
        title={t("Open conversation")}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {open ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-text/88">{row.title || row.id}</span>
        <span className="shrink-0 text-[10px] text-muted">
          {formatRelativeTime(row.updatedAt, t)}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(row)}
        title={t("Delete")}
        className="shrink-0 rounded p-1 text-muted opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function ProjectGroup({
  project,
  label,
  pathTitle,
  removable = true,
  rows,
  openKeys,
  agents,
  onOpen,
  onDelete,
  onPickAgent,
  onDeleteProject,
  emptyLabel,
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  // Which agent a new conversation in this project should use. Opening the
  // chooser instead of starting immediately is the point: the project only says
  // where, not which agent, and defaulting to whichever agent happens to be
  // first is how every new conversation ended up on the same one.
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const VISIBLE = 4;
  const visible = showAll ? rows : rows.slice(0, VISIBLE);
  const hidden = rows.length - visible.length;

  return (
    <div className="space-y-0.5">
      <div className="group flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-hover">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          title={pathTitle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{label}</span>
          {rows.length > 0 ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted">{rows.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => setAgentMenuOpen((prev) => !prev)}
          aria-expanded={agentMenuOpen}
          title={t("New conversation in this project")}
          className={[
            "shrink-0 rounded p-1 transition-opacity",
            agentMenuOpen
              ? "bg-accent-soft text-accent opacity-100"
              : "text-muted opacity-0 hover:bg-hover hover:text-text group-hover:opacity-100 focus:opacity-100",
          ].join(" ")}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {removable ? (
          <button
            type="button"
            onClick={() => onDeleteProject(project)}
            title={t("Remove project")}
            className="shrink-0 rounded p-1 text-muted opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {agentMenuOpen ? (
        <div className="mb-1 ml-4 overflow-hidden rounded-lg border border-border bg-elevated shadow-overlay">
          <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-[0.08em] text-subtle uppercase">
            {t("Start a conversation with")}
          </div>
          <AcpAgentMenu
            agents={agents}
            onPick={(agentId) => {
              setAgentMenuOpen(false);
              onPickAgent(project, agentId);
            }}
          />
        </div>
      ) : null}

      {expanded ? (
        <div className="pl-4">
          {rows.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted">{emptyLabel}</p>
          ) : (
            visible.map((row) => (
              <HistoryRow
                key={row.id}
                row={row}
                open={openKeys.has(`${row.agentId}:${row.id}`)}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))
          )}
          {hidden > 0 || showAll ? (
            <button
              type="button"
              onClick={() => setShowAll((prev) => !prev)}
              className="px-2 py-1 text-[11px] text-accent hover:underline"
            >
              {showAll ? t("Show less") : t("Show more")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AcpHistoryPanel({
  projects,
  history,
  agents,
  activeAgentId,
  activeAgentName,
  activeAgentCwd,
  openKeys,
  onOpen,
  onDelete,
  onPickAgent,
  onAddProject,
  onDeleteProject,
  onClose,
}) {
  const { t } = useI18n();
  const knownProjectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  );
  // Conversations are per-agent state: a codex conversation cannot be resumed
  // by Claude Code, so only the selected agent's own history is listed.
  const agentHistory = useMemo(
    () => history.filter((row) => !activeAgentId || row.agentId === activeAgentId),
    [history, activeAgentId],
  );
  const ungrouped = agentHistory.filter(
    (row) => !row.projectId || !knownProjectIds.has(row.projectId),
  );
  const defaultGroup = { id: null, name: t("No project"), path: null, virtual: true };

  return (
    <section className="absolute inset-0 z-20 flex flex-col bg-surface">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">
          {t("Conversations")}
          {activeAgentName ? (
            <span className="ml-1.5 font-normal text-muted">· {activeAgentName}</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onAddProject}
          title={t("Add a local folder as a project")}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-[11px] font-medium text-text/88 hover:bg-hover"
        >
          <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("New project")}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          title={t("Close")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      <div className="scroll-region min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ProjectGroup
          project={defaultGroup}
          label={defaultGroup.name}
          pathTitle={activeAgentCwd || t("Default working directory")}
          removable={false}
          rows={ungrouped}
          openKeys={openKeys}
          agents={agents}
          onOpen={onOpen}
          onDelete={onDelete}
          onPickAgent={onPickAgent}
          onDeleteProject={onDeleteProject}
          emptyLabel={t("No conversations yet")}
        />

        {projects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            label={project.name}
            pathTitle={project.path}
            rows={agentHistory.filter((row) => row.projectId === project.id)}
            openKeys={openKeys}
            agents={agents}
            onOpen={onOpen}
            onDelete={onDelete}
            onPickAgent={onPickAgent}
            onDeleteProject={onDeleteProject}
            emptyLabel={t("No conversations yet")}
          />
        ))}

        {projects.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] leading-relaxed text-muted">
            {t("No projects yet. Add a local folder to keep its sessions together.")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
