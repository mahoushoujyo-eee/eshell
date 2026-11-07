import AcpAgentLogo from "../../ai/AcpAgentLogo";
import { formatAcpAgentSpawn } from "../../../lib/acpAgentBrands";
import { useI18n } from "../../../lib/i18n";

/**
 * The agent chooser for "start a conversation with…".
 *
 * One list, two placements: the tab strip renders it inside a popover, and the
 * history panel expands it inline under a project row (a popover there would be
 * clipped by the panel's scroll container). Both need the same rows — brand
 * mark, name, spawn command, and whether that agent's process is already up —
 * so the rows live here.
 */
export default function AcpAgentMenu({ agents, onPick, className = "" }) {
  const { t } = useI18n();

  if (agents.length === 0) {
    return (
      <div className={`px-3 py-2.5 text-[11px] text-muted ${className}`}>
        {t("No agent configured")}
      </div>
    );
  }

  return (
    <div className={`scroll-region max-h-72 space-y-0.5 overflow-y-auto p-1 ${className}`}>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onPick(agent.id)}
          title={formatAcpAgentSpawn(agent)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
        >
          <AcpAgentLogo agent={agent} className="h-6 w-6" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-text">{agent.name}</span>
              {agent.running ? (
                <span
                  title={t("Agent process running")}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-success ring-2 ring-success/20"
                />
              ) : null}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
              {formatAcpAgentSpawn(agent)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
