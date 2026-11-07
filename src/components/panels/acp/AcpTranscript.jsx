import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  ListTodo,
  Loader2,
  ShieldQuestion,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { MARKDOWN_COMPONENTS } from "../ai-assistant/aiAssistantUtils";
import AcpNoticeRow from "./AcpNoticeRow";
import { useI18n } from "../../../lib/i18n";

/**
 * Transcript rendering for one ACP conversation: markdown replies, collapsible
 * thoughts, tool cards with diffs/output, inline permission requests, and the
 * plan card. Extracted from the panel so the panel itself stays a layout shell
 * over the multi-conversation state.
 */

const TOOL_STATUS_META = {
  pending: { labelKey: "Pending", className: "text-muted" },
  in_progress: { labelKey: "Running", className: "text-warning" },
  completed: { labelKey: "Completed", className: "text-success" },
  failed: { labelKey: "Failed", className: "text-danger" },
};

// Status is a 6px dot in a fixed 12px slot, the way Claude Code renders tool
// state: one glyph whose only job is colour, in a fixed slot so stacked rows
// stay aligned. Shape carries the state too — pending is hollow, running
// pulses — so it survives without colour. The 2px left rail this replaced put
// a saturated colour bar on every row, and a run of them read as a fence.
const TOOL_STATUS_DOT = {
  pending: "border border-muted/60",
  in_progress: "bg-warning animate-pulse",
  completed: "bg-success/65",
  failed: "bg-danger",
};

function ToolStatusIcon({ status }) {
  return (
    <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
      <span
        className={`size-1.5 rounded-full ${
          TOOL_STATUS_DOT[status] || TOOL_STATUS_DOT.pending
        }`}
      />
    </span>
  );
}

function Markdown({ text }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function DiffBlock({ diff, t }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="border-b border-border bg-hover px-2 py-1 font-mono text-[10px] text-muted">
        {diff.path}
      </div>
      {diff.oldText ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-danger/10 px-2 py-1 font-mono text-[11px] leading-snug text-danger">
          {diff.oldText}
        </pre>
      ) : null}
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-success/10 px-2 py-1 font-mono text-[11px] leading-snug text-success">
        {diff.newText || t("(empty)")}
      </pre>
    </div>
  );
}

function ToolContentBlocks({ content, t }) {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1.5">
      {content.map((block, index) => {
        if (block.type === "diff") {
          return <DiffBlock key={index} diff={block} t={t} />;
        }
        if (block.type === "terminal") {
          return (
            <div key={index} className="font-mono text-[11px] text-muted">
              {t("Terminal")}: {block.terminalId}
            </div>
          );
        }
        if (!block.text) {
          return null;
        }
        return (
          <pre
            key={index}
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel px-2 py-1.5 font-mono text-[11px] leading-snug text-text/88"
          >
            {block.text}
          </pre>
        );
      })}
    </div>
  );
}

// MCP tool names arrive as `mcp__{server}__{tool}`. Claude Code strips that
// prefix for display and shows the server separately; splitting on the LAST
// `__` rather than the first keeps servers whose own name contains an
// underscore intact.
function splitToolTitle(title) {
  const rest = String(title || "");
  if (!rest.startsWith("mcp__")) {
    return { name: rest, server: null };
  }
  const body = rest.slice(5);
  const cut = body.lastIndexOf("__");
  return cut > 0
    ? { name: body.slice(cut + 2), server: body.slice(0, cut) }
    : { name: rest, server: null };
}

// The name carries the row: every MCP tool gets kind "other" from the backend,
// so a kind chip read "OTHER" on nearly every row while the real signal — the
// tool name — sat beside it in mono. The server is deliberately not repeated
// per row; the full name stays in the row's tooltip.
function ToolCallSummary({ tool }) {
  const { name } = splitToolTitle(tool.title);
  return (
    <span className="min-w-0 flex-1 truncate text-left font-medium text-text/90">{name}</span>
  );
}

function ToolCallCard({ tool }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const statusMeta = TOOL_STATUS_META[tool.status] || TOOL_STATUS_META.pending;
  const hasDetails =
    (tool.content && tool.content.length > 0) ||
    (tool.locations && tool.locations.length > 0) ||
    tool.rawInput != null;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((prev) => !prev)}
        title={tool.title || undefined}
        className={[
          "group flex w-full items-center gap-2 rounded-md py-1.5 pr-1.5 pl-1",
          hasDetails ? "cursor-pointer hover:bg-hover" : "cursor-default",
        ].join(" ")}
      >
        <ToolStatusIcon status={tool.status} />
        <ToolCallSummary tool={tool} />
        {/* The dot carries the state visually; this keeps it for screen readers
            and the hover title. */}
        <span className="sr-only">{t(statusMeta.labelKey)}</span>
        {hasDetails ? (
          expanded ? (
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:text-muted"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:text-muted"
              aria-hidden="true"
            />
          )
        ) : null}
      </button>
      {expanded ? (
        /* Flush with the row above it (same pl-1 inset), not indented under
           the tool name. */
        <div className="space-y-2 pt-0.5 pr-1 pb-2 pl-1">
          {tool.locations && tool.locations.length > 0 ? (
            <div className="space-y-0.5">
              {tool.locations.map((location, index) => (
                <div key={index} className="truncate font-mono text-[10px] text-muted">
                  {location.path}
                  {location.line != null ? `:${location.line}` : null}
                </div>
              ))}
            </div>
          ) : null}
          <ToolContentBlocks content={tool.content} t={t} />
          {tool.rawInput != null ? (
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer select-none">{t("Raw input")}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel px-2 py-1 font-mono text-[10px]">
                {JSON.stringify(tool.rawInput, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Sign-in card shown when the agent rejected session creation with
// AUTH_REQUIRED: one button per advertised auth method, plus manual fallbacks.
export function AcpAuthCard({ methods, authenticating, onAuthenticate, onCancel }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-warning/35 bg-warning/8 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-2 text-warning">
        <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-sm font-semibold">{t("Sign-in required")}</span>
      </div>
      <p className="mt-1.5 leading-relaxed text-text/88">
        {t("The agent needs to authenticate before it can create a session. Choose a sign-in method:")}
      </p>
      {authenticating ? (
        <div className="mt-2 flex items-center gap-2 text-text/88">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span className="flex-1">
            {t("Waiting for sign-in to complete (a browser window may have opened)…")}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-md border border-border-strong bg-transparent px-2 py-1 font-medium text-text/88 hover:bg-danger/10 hover:text-danger"
          >
            {t("Cancel")}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {methods.length > 0 ? (
            methods.map((method) => (
              <button
                key={method.id}
                type="button"
                onClick={() => onAuthenticate(method.id)}
                title={method.description || undefined}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent/88"
              >
                {method.name}
              </button>
            ))
          ) : (
            <span className="text-muted">{t("The agent did not advertise any sign-in method.")}</span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border-strong bg-transparent px-2.5 py-1 font-medium text-text/88 hover:bg-hover"
          >
            {t("Cancel")}
          </button>
        </div>
      )}
      <p className="mt-2 leading-relaxed text-muted">
        {t("Alternatively, sign in from a terminal first (e.g. codex login), or set CODEX_API_KEY / OPENAI_API_KEY in the agent's env in .eshell-data/acp_agents.json, then restart the agent.")}
      </p>
    </div>
  );
}

function permissionButtonClass(kind, resolving) {
  const base =
    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors wrap-anywhere disabled:opacity-50";
  if (kind === "allow_once" || kind === "allow_always") {
    return `${base} bg-accent text-on-accent hover:bg-accent/88 ${resolving ? "" : ""}`;
  }
  return `${base} border border-danger/50 text-danger hover:bg-danger/10`;
}

function PermissionCard({ entry, onRespond }) {
  const { t } = useI18n();
  const resolved = entry.resolution != null;
  const chosen = resolved
    ? entry.options.find((option) => option.optionId === entry.resolution.optionId) || null
    : null;

  return (
    <div className="rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-warning">
        <ShieldQuestion className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">{t("Permission request")}</span>
      </div>
      {entry.toolCall ? (
        <div className="mt-1.5 flex items-center gap-2">
          <ToolCallSummary tool={entry.toolCall} />
        </div>
      ) : null}
      {entry.toolCall?.content?.length ? (
        <div className="mt-1.5">
          <ToolContentBlocks content={entry.toolCall.content} t={t} />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {resolved ? (
          <span className="inline-flex items-center gap-1 text-muted">
            {entry.resolution.cancelled ? (
              <>
                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                {t("Cancelled")}
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                {chosen ? chosen.name : t("Resolved")}
              </>
            )}
          </span>
        ) : (
          entry.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              disabled={entry.resolving}
              onClick={() => onRespond(entry.requestId, option.optionId)}
              className={permissionButtonClass(option.kind, entry.resolving)}
            >
              {option.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ThoughtEntry({ text }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-1.5 pl-1 text-muted hover:bg-hover"
      >
        {/* Same 12px slot as the tool rows' status dot, so thoughts and tool
            calls still line up when they interleave in one transcript. */}
        <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
          <Brain className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">
          {expanded ? t("Thinking") : text.replaceAll("\n", " ").slice(0, 80)}
        </span>
        {expanded ? (
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:text-muted"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:text-muted"
            aria-hidden="true"
          />
        )}
      </button>
      {expanded ? (
        <div className="pt-0.5 pr-1 pb-2 pl-1 leading-relaxed wrap-anywhere whitespace-pre-wrap text-muted italic">
          {text}
        </div>
      ) : null}
    </div>
  );
}

export function PlanCard({ plan }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const completed = plan.filter((entry) => entry.status === "completed").length;
  return (
    <div className="shrink-0 border-t border-border bg-panel px-3 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 text-text/88"
      >
        <ListTodo className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="flex-1 text-left font-medium">
          {t("Plan")} · {completed}/{plan.length}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <ul className="mt-1.5 max-h-36 space-y-1 overflow-x-hidden overflow-y-auto pb-0.5">
          {plan.map((entry, index) => (
            <li key={index} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                <ToolStatusIcon status={entry.status} />
              </span>
              <span
                className={[
                  "min-w-0 wrap-anywhere",
                  entry.status === "completed" ? "text-muted line-through" : "text-text/88",
                ].join(" ")}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function TranscriptEntry({ entry, onRespondPermission }) {
  const { t } = useI18n();
  if (entry.type === "user") {
    const images = Array.isArray(entry.images) ? entry.images : [];
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent-soft px-3 py-2 text-[13.5px] leading-relaxed text-text">
          {images.length > 0 ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {images.map((image, index) =>
                image.previewUrl ? (
                  <img
                    key={index}
                    src={image.previewUrl}
                    alt=""
                    className="h-16 w-16 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span
                    key={index}
                    className="rounded border border-border-strong bg-transparent px-1.5 py-0.5 font-mono text-[10px] text-muted"
                  >
                    {image.mimeType || "image"}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {entry.text ? (
            <span className="wrap-anywhere whitespace-pre-wrap">{entry.text}</span>
          ) : null}
          {entry.context ? (
            <details className="mt-1.5 text-xs">
              <summary className="cursor-pointer select-none text-text/70">
                <TerminalSquare className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden="true" />
                {t("Terminal selection")} · {entry.context.sessionName}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel px-2 py-1 font-mono text-[11px] leading-snug">
                {entry.context.content}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    );
  }
  if (entry.type === "assistant") {
    return (
      <div className="px-0.5 py-0.5 text-text">
        <Markdown text={entry.text} />
      </div>
    );
  }
  if (entry.type === "thought") {
    return <ThoughtEntry text={entry.text} />;
  }
  if (entry.type === "tool") {
    return <ToolCallCard tool={entry.tool} />;
  }
  if (entry.type === "permission") {
    return <PermissionCard entry={entry} onRespond={onRespondPermission} />;
  }
  if (entry.type === "notice") {
    return <AcpNoticeRow entry={entry} />;
  }
  return null;
}
