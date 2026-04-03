import { normalizeShellContextAttachment } from "../../../lib/ops-agent-shell-context";
import { ShellContextChip } from "./AiAssistantControls";
import { formatTime, roleLabel } from "./aiAssistantUtils";

export default function AiUserMessage({
  group,
  isDrawer,
  expandedShellMessageIds,
  onToggleShellContextMessage,
}) {
  const message = group.message;
  const shellContext = normalizeShellContextAttachment(message.shellContext);
  const shellContextExpanded = Boolean(expandedShellMessageIds[message.id]);

  return (
    <div className="flex justify-end">
      <article
        className={[
          "max-w-[92%] border border-accent bg-accent px-4 py-3 text-xs text-white",
          isDrawer
            ? "rounded-3xl shadow-[0_12px_30px_rgba(12,18,24,0.08)]"
            : "rounded-2xl shadow-none",
        ].join(" ")}
      >
        <div className="mb-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] opacity-80">
          <span>{roleLabel(message.role)}</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        {shellContext ? (
          <div className="mb-2">
            <ShellContextChip
              shellContext={shellContext}
              expanded={shellContextExpanded}
              onToggle={() => onToggleShellContextMessage(message.id)}
              inverted
            />
          </div>
        ) : null}
        {shellContext && shellContextExpanded ? (
          <div className="mb-2 rounded-2xl border border-white/18 bg-black/12 px-3 py-2 text-white/92">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
              {shellContext.content}
            </pre>
          </div>
        ) : null}
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{message.content}</pre>
      </article>
    </div>
  );
}
