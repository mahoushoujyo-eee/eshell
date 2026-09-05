import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleStop,
  History,
  KeyRound,
  ListTodo,
  Loader2,
  Play,
  RotateCcw,
  Send,
  ShieldQuestion,
  Square,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
import { MARKDOWN_COMPONENTS } from "./ai-assistant/aiAssistantUtils";
import { AcpAgentPicker, AcpModePicker, AcpSessionSettingsMenu } from "./acp/AcpPickers";
import AcpAgentLogo from "../ai/AcpAgentLogo";
import { formatAcpAgentSpawn } from "../../lib/acpAgentBrands";
import { visibleConfigOptions } from "../../lib/acpConfigOptions";
import { formatShellContextPreview } from "../../lib/ops-agent-shell-context";
import { useI18n } from "../../lib/i18n";

/**
 * ACP agent chat panel, docked where the legacy AI assistant lived.
 *
 * Pure view over the `useAcpAgent` hook: renders the transcript (markdown
 * messages, collapsible thoughts, tool-call cards with diffs/output,
 * interactive permission requests), the live plan, session modes, slash
 * command completion, and the composer.
 */

const TOOL_STATUS_META = {
  pending: { labelKey: "Pending", className: "text-muted" },
  in_progress: { labelKey: "Running", className: "text-amber-500" },
  completed: { labelKey: "Completed", className: "text-emerald-500" },
  failed: { labelKey: "Failed", className: "text-red-500" },
};

// Reads one image file into a prompt attachment (base64 payload + preview URL).
// Oversized images are downscaled/re-encoded client-side: Codex-side image
// preparation silently replaces too-large images with an "omitted" placeholder,
// and smaller payloads cost fewer tokens anyway.
const MAX_IMAGE_DIMENSION = 1568;
const MAX_IMAGE_DATAURL_CHARS = 5 * 1024 * 1024;

const nextAttachmentId = () => `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const attachmentFromDataUrl = (dataUrl, mimeType) => ({
  id: nextAttachmentId(),
  data: dataUrl.slice(dataUrl.indexOf(",") + 1),
  mimeType,
  previewUrl: dataUrl,
});

const normalizeImage = (dataUrl, mimeType) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height, 1));
      if (scale >= 1 && dataUrl.length <= MAX_IMAGE_DATAURL_CHARS) {
        resolve(attachmentFromDataUrl(dataUrl, mimeType));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(attachmentFromDataUrl(dataUrl, mimeType));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let outMime = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
      let out = canvas.toDataURL(outMime, 0.9);
      if (out.length > MAX_IMAGE_DATAURL_CHARS) {
        outMime = "image/jpeg";
        out = canvas.toDataURL(outMime, 0.85);
      }
      resolve(attachmentFromDataUrl(out, outMime));
    };
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = dataUrl;
  });

const readImageFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      normalizeImage(dataUrl, file.type || "image/png").then(resolve, reject);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });

function ToolStatusIcon({ status }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />;
  }
  if (status === "in_progress") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" aria-hidden="true" />;
  }
  return <CircleDashed className="h-3.5 w-3.5 text-muted" aria-hidden="true" />;
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
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="border-b border-border/60 bg-surface/80 px-2 py-1 font-mono text-[10px] text-muted">
        {diff.path}
      </div>
      {diff.oldText ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-red-500/10 px-2 py-1 font-mono text-[11px] leading-snug text-red-600 dark:text-red-400">
          {diff.oldText}
        </pre>
      ) : null}
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-emerald-500/10 px-2 py-1 font-mono text-[11px] leading-snug text-emerald-700 dark:text-emerald-400">
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
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-surface/70 px-2 py-1.5 font-mono text-[11px] leading-snug text-text/88"
          >
            {block.text}
          </pre>
        );
      })}
    </div>
  );
}

// The kind badge is fixed-height and centers its own glyphs (`leading-none` +
// flex centering) instead of relying on the mono font's ascent/descent inside an
// inherited ratio line-height — that made its text sit high in the pill. The
// extra 1px offset is optical: an all-caps badge reads high next to the
// underscore-heavy monospace tool names it labels.
function ToolCallSummary({ tool }) {
  return (
    <>
      <span className="relative top-px inline-flex h-[18px] shrink-0 items-center rounded bg-surface px-1.5 font-mono text-[10px] uppercase leading-none tracking-wide text-muted">
        {tool.kind || "tool"}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-text/88">{tool.title}</span>
    </>
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
    <div className="rounded-lg border border-border/60 bg-surface/50 text-xs">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((prev) => !prev)}
        className={[
          "flex w-full items-center gap-2 px-2.5 py-1.5",
          hasDetails ? "cursor-pointer hover:bg-accent/5" : "cursor-default",
        ].join(" ")}
      >
        <ToolStatusIcon status={tool.status} />
        <ToolCallSummary tool={tool} />
        <span className={`shrink-0 font-medium ${statusMeta.className}`}>
          {t(statusMeta.labelKey)}
        </span>
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          )
        ) : null}
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
          {tool.locations && tool.locations.length > 0 ? (
            <div className="space-y-0.5">
              {tool.locations.map((location, index) => (
                <div key={index} className="truncate font-mono text-[10px] text-muted">
                  {location.path}
                  {location.line != null ? `:${location.line}` : ""}
                </div>
              ))}
            </div>
          ) : null}
          <ToolContentBlocks content={tool.content} t={t} />
          {tool.rawInput != null ? (
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer select-none">{t("Raw input")}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface/70 px-2 py-1 font-mono text-[10px]">
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
function AcpAuthCard({ methods, authenticating, onAuthenticate, onCancel }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
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
            className="shrink-0 rounded-md border border-border bg-surface px-2 py-1 font-medium text-text/88 hover:bg-red-500/10 hover:text-red-500"
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
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90"
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
            className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-text/88 hover:bg-accent/10"
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

/**
 * Recovery card for an orphaned backend runner.
 *
 * The Rust agent registry outlives the webview, so a reload (dev HMR, devtools,
 * a crashed frontend) leaves the agent process running with no frontend state
 * pointing at it. `acp_agent_start` then refuses with "already has an active
 * session" and the session can only be reclaimed by stopping that runner —
 * which is what this card offers, since nothing else in the panel can reach an
 * agent it is not engaged with.
 */
function OrphanedSessionCard({ agent, busy, onReclaim, onStop }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-sm font-semibold">{t("Orphaned session")}</span>
      </div>
      <p className="mt-1.5 leading-relaxed text-text/88">
        {t(
          "This agent's process is still running but no window is driving it any more (usually left over after a reload). Stop it to open a new session.",
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={onReclaim}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {busy ? t("Starting…") : t("Stop and start")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onStop}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-text/88 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
        >
          <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Stop session")}
        </button>
      </div>
      {agent ? (
        <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-muted">
          {formatAcpAgentSpawn(agent)}
        </p>
      ) : null}
    </div>
  );
}

function permissionButtonClass(kind, resolving) {
  const base =
    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50";
  if (kind === "allow_once" || kind === "allow_always") {
    return `${base} bg-accent text-white hover:opacity-90 ${resolving ? "" : ""}`;
  }
  return `${base} border border-red-500/50 text-red-500 hover:bg-red-500/10`;
}

function PermissionCard({ entry, onRespond }) {
  const { t } = useI18n();
  const resolved = entry.resolution != null;
  const chosen = resolved
    ? entry.options.find((option) => option.optionId === entry.resolution.optionId) || null
    : null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
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
                <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
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
    <div className="rounded-lg border border-border/40 bg-surface/30 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-muted hover:bg-accent/5"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left">
          {expanded ? t("Thinking") : text.replaceAll("\n", " ").slice(0, 80)}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <div className="whitespace-pre-wrap border-t border-border/40 px-2.5 py-2 italic leading-relaxed text-muted">
          {text}
        </div>
      ) : null}
    </div>
  );
}

function NoticeRow({ entry }) {
  const { t } = useI18n();
  const detail = entry.detail || "";
  let text;
  switch (entry.code) {
    case "session-ended":
      text = t("Session ended");
      break;
    case "start-failed":
      text = `${t("Failed to start agent")}: ${detail}`;
      break;
    case "turn-stopped":
      if (detail === "cancelled") {
        text = t("Turn cancelled");
      } else if (detail === "refusal") {
        text = t("The agent declined this request");
      } else if (detail === "max_tokens") {
        text = t("Stopped: max tokens reached");
      } else {
        text = `${t("Turn stopped")}: ${detail}`;
      }
      break;
    case "turn-failed":
      text = `${t("Turn failed")}: ${detail}`;
      break;
    case "auth-failed":
      text = `${t("Sign-in failed")}: ${detail}`;
      break;
    case "resume-fallback":
      text = t("This agent cannot restore the previous context; a fresh session was created instead.");
      break;
    case "mode-failed":
      text = `${t("Failed to switch mode")}: ${detail}`;
      break;
    case "config-option-failed":
      text = `${t("Failed to change setting")}: ${detail}`;
      break;
    case "permission-failed":
      text = `${t("Failed to respond to permission request")}: ${detail}`;
      break;
    case "agent-error":
      text = `${t("Agent error")}: ${detail}`;
      break;
    default:
      text = detail;
  }
  if (entry.tone === "error") {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
        {text}
      </div>
    );
  }
  return <div className="py-0.5 text-center text-[11px] text-muted">{text}</div>;
}

function PlanCard({ plan }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const completed = plan.filter((entry) => entry.status === "completed").length;
  return (
    <div className="shrink-0 border-t border-border/60 bg-surface/40 px-3 py-1.5 text-xs">
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
        <ul className="mt-1.5 max-h-36 space-y-1 overflow-y-auto pb-0.5">
          {plan.map((entry, index) => (
            <li key={index} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                <ToolStatusIcon status={entry.status} />
              </span>
              <span
                className={
                  entry.status === "completed" ? "text-muted line-through" : "text-text/88"
                }
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

function TranscriptEntry({ entry, onRespondPermission }) {
  const { t } = useI18n();
  if (entry.type === "user") {
    const images = Array.isArray(entry.images) ? entry.images : [];
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent/10 px-3 py-2 text-sm leading-relaxed text-text">
          {images.length > 0 ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {images.map((image, index) =>
                image.previewUrl ? (
                  <img
                    key={index}
                    src={image.previewUrl}
                    alt=""
                    className="h-16 w-16 rounded-md border border-border/60 object-cover"
                  />
                ) : (
                  <span
                    key={index}
                    className="rounded border border-border/60 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
                  >
                    {image.mimeType || "image"}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {entry.text ? <span className="whitespace-pre-wrap">{entry.text}</span> : null}
          {entry.context ? (
            <details className="mt-1.5 text-xs">
              <summary className="cursor-pointer select-none text-text/70">
                <TerminalSquare className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden="true" />
                {t("Terminal selection")} · {entry.context.sessionName}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-black/10 px-2 py-1 font-mono text-[11px] leading-snug dark:bg-black/30">
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
      <div className="rounded-lg bg-surface/70 px-3 py-2 text-sm leading-relaxed text-text">
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
    return <NoticeRow entry={entry} />;
  }
  return null;
}

// History browser: list of persisted sessions, with per-entry view/resume/delete.
function AcpHistoryPanel({ history, phase, onView, onResume, onDelete, onClose }) {
  const { t } = useI18n();
  const canResume = phase === "idle";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text/88 hover:bg-accent/10"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Back")}
        </button>
        <span className="text-sm font-semibold text-text">{t("Session history")}</span>
      </div>
      {history.length === 0 ? (
        <div className="pt-8 text-center text-xs text-muted">{t("No saved sessions yet.")}</div>
      ) : (
        history.map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface/50 px-3 py-2 text-xs"
          >
            <button
              type="button"
              onClick={() => onView(row)}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              title={t("View transcript")}
            >
              <AcpAgentLogo
                agent={{ id: row.agentId, name: row.agentName }}
                className="h-7 w-7"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-text">{row.title || row.id}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
                  <span className="shrink-0">{row.agentName || row.agentId}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">
                    {(row.updatedAt || "").replace("T", " ").slice(0, 16)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">
                    {t("{count} entries", { count: row.entryCount })}
                  </span>
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={!canResume}
              onClick={() => onResume(row)}
              title={canResume ? t("Resume session") : t("Stop the current session first")}
              className="shrink-0 rounded-md border border-border bg-surface p-1.5 text-text/88 hover:bg-accent/10 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(row)}
              title={t("Delete")}
              className="shrink-0 rounded-md border border-border bg-surface p-1.5 text-text/88 hover:bg-red-500/10 hover:text-red-500"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// Read-only transcript of one persisted session.
function AcpHistoryRecordView({ record, phase, onBack, onResume }) {
  const { t } = useI18n();
  const entries = Array.isArray(record.transcript) ? record.transcript : [];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text/88 hover:bg-accent/10"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Back")}
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
          {record.title || record.id}
        </span>
        {phase === "idle" ? (
          <button
            type="button"
            onClick={() => onResume(record)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Resume session")}
          </button>
        ) : null}
      </div>
      <div className="rounded-md border border-border/40 bg-surface/30 px-2 py-1 text-[11px] text-muted">
        {t("Read-only transcript. Resuming reopens the session with the agent when it supports session/load.")}
      </div>
      {entries.map((entry, index) => (
        <TranscriptEntry
          key={entry.id || index}
          entry={entry}
          onRespondPermission={() => {}}
        />
      ))}
    </div>
  );
}

export default function AcpAgentPanel({ acp, onClose }) {
  const { t } = useI18n();
  const {
    agents,
    activeAgentId,
    setActiveAgentId,
    phase,
    session,
    authMethods,
    transcript,
    plan,
    commands,
    configOptions,
    usage,
    turnActive,
    history,
    shellContext,
    clearShellContext,
    start,
    stop,
    reclaimAndStart,
    authenticate,
    resumeHistory,
    getHistoryRecord,
    deleteHistoryRecord,
    sendPrompt,
    cancelTurn,
    setMode,
    setConfigOption,
    respondPermission,
  } = acp;

  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState(null);
  // Header popovers: null | "agent" | "mode" (only one open at a time).
  const [openMenu, setOpenMenu] = useState(null);
  const scrollRef = useRef(null);
  const nearBottomRef = useRef(true);
  // Menus live in two places now: agent in the header, mode in the composer.
  const headerMenuRef = useRef(null);
  const composerMenuRef = useRef(null);

  const ready = phase === "ready" && session != null;
  const starting = phase === "starting";
  const authActive = phase === "auth" || phase === "authenticating";
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) || null,
    [agents, activeAgentId],
  );
  // Backend runner alive while this panel holds no session: the process is
  // orphaned and a plain start would fail with "already has an active session".
  const orphanedSession = phase === "idle" && Boolean(activeAgent?.running);
  const stopTargetId = session?.agentId || activeAgentId;

  // Autoscroll while streaming unless the user scrolled up to read.
  useEffect(() => {
    const node = scrollRef.current;
    if (node && nearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript]);

  const handleScroll = useCallback((event) => {
    const node = event.currentTarget;
    nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }, []);

  // Dismiss the header popovers on outside click or Escape. Escape is captured
  // here so it closes the menu instead of bubbling up to App's "close dock".
  useEffect(() => {
    if (!openMenu) {
      return undefined;
    }
    const handlePointerDown = (event) => {
      if (headerMenuRef.current?.contains(event.target)) {
        return;
      }
      if (composerMenuRef.current?.contains(event.target)) {
        return;
      }
      setOpenMenu(null);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpenMenu(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [openMenu]);

  // The agent choice is locked while a session is live; a stale popover would
  // otherwise stay open across a start.
  useEffect(() => {
    if (openMenu === "agent" && (ready || starting)) {
      setOpenMenu(null);
    }
  }, [openMenu, ready, starting]);

  const handleSend = useCallback(
    async (event) => {
      event?.preventDefault?.();
      const text = question.trim();
      if ((!text && attachments.length === 0 && !shellContext) || !ready || turnActive) {
        return;
      }
      setQuestion("");
      const images = attachments;
      setAttachments([]);
      nearBottomRef.current = true;
      await sendPrompt(text, images);
    },
    [attachments, question, ready, sendPrompt, shellContext, turnActive],
  );

  const supportsImages = Boolean(session?.capabilities?.promptImage);

  const addImageFiles = useCallback(
    async (files) => {
      if (!supportsImages) {
        return;
      }
      const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return;
      }
      try {
        const loaded = await Promise.all(imageFiles.map(readImageFile));
        setAttachments((prev) => [...prev, ...loaded]);
      } catch {
        // Unreadable files are dropped silently; the picker can be retried.
      }
    },
    [supportsImages],
  );

  const openHistoryRecord = useCallback(
    async (row) => {
      try {
        const record = await getHistoryRecord(row.id);
        setViewingRecord(record);
      } catch {
        setViewingRecord(null);
      }
    },
    [getHistoryRecord],
  );

  const handleResumeHistory = useCallback(
    async (record) => {
      setHistoryOpen(false);
      setViewingRecord(null);
      await resumeHistory(record);
    },
    [resumeHistory],
  );

  // Slash command completion: filter advertised commands by the typed prefix.
  const commandSuggestions = useMemo(() => {
    if (!question.startsWith("/") || question.includes(" ") || commands.length === 0) {
      return [];
    }
    const prefix = question.slice(1).toLowerCase();
    return commands
      .filter((command) => command.name.toLowerCase().startsWith(prefix))
      .slice(0, 6);
  }, [commands, question]);

  const modes = session?.modes;
  // Agent-advertised selectors (model, thought level, ...). The mode mirror is
  // filtered out here because `modes` above already drives that same setting.
  const sessionConfigOptions = useMemo(
    () => (ready ? visibleConfigOptions(configOptions) : []),
    [configOptions, ready],
  );
  const canSend =
    ready &&
    !turnActive &&
    (question.trim().length > 0 || attachments.length > 0 || shellContext != null);
  const usagePercent =
    usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/80 px-3 py-2.5">
        {/* The agent picker carries the panel's visible identity (brand mark +
            name), so the heading only needs to exist for assistive tech. */}
        <h2 className="sr-only">{t("ACP Agent")}</h2>
        <div
          ref={headerMenuRef}
          className="relative flex min-w-0 flex-1 items-center gap-1.5"
          title={session ? `${t("Session")}: ${session.id}` : undefined}
        >
          <AcpAgentPicker
            agents={agents}
            activeAgentId={activeAgentId}
            locked={ready || starting}
            open={openMenu === "agent"}
            onToggle={() => setOpenMenu((prev) => (prev === "agent" ? null : "agent"))}
            onSelect={(agentId) => {
              setActiveAgentId(agentId);
              setOpenMenu(null);
            }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {usagePercent != null ? (
            <span
              className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
              title={`${usage.used} / ${usage.size}`}
            >
              {usagePercent}%
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setViewingRecord(null);
              setHistoryOpen((prev) => !prev);
            }}
            title={t("Session history")}
            className={[
              "rounded-md border border-border bg-surface px-2 py-1 text-xs",
              historyOpen ? "text-accent" : "text-text/88 hover:bg-accent/10",
            ].join(" ")}
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {ready || orphanedSession ? (
            <button
              type="button"
              onClick={() => stop(stopTargetId)}
              title={orphanedSession ? t("Stop session") : t("Stop agent")}
              className={[
                "rounded-md border bg-surface px-2 py-1 text-xs font-medium hover:bg-red-500/10 hover:text-red-500",
                orphanedSession
                  ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                  : "border-border text-text/88",
              ].join(" ")}
            >
              <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            title={t("Close")}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text/88 hover:bg-accent/10"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {historyOpen ? (
          viewingRecord ? (
            <AcpHistoryRecordView
              record={viewingRecord}
              phase={phase}
              onBack={() => setViewingRecord(null)}
              onResume={handleResumeHistory}
            />
          ) : (
            <AcpHistoryPanel
              history={history}
              phase={phase}
              onView={openHistoryRecord}
              onResume={handleResumeHistory}
              onDelete={(row) => void deleteHistoryRecord(row.id)}
              onClose={() => setHistoryOpen(false)}
            />
          )
        ) : authActive ? (
          <div className="space-y-2">
            <AcpAuthCard
              methods={authMethods}
              authenticating={phase === "authenticating"}
              onAuthenticate={authenticate}
              onCancel={stop}
            />
            {transcript.map((entry) => (
              <TranscriptEntry
                key={entry.id}
                entry={entry}
                onRespondPermission={respondPermission}
              />
            ))}
          </div>
        ) : !ready && transcript.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted">
            {activeAgent ? (
              <AcpAgentLogo agent={activeAgent} className="h-12 w-12 rounded-[14px]" />
            ) : (
              <Bot className="h-8 w-8 opacity-40" aria-hidden="true" />
            )}
            {activeAgent ? (
              <div className="space-y-1">
                <p className="text-sm font-semibold text-text">{activeAgent.name}</p>
                <p
                  className="mx-auto max-w-full break-all font-mono text-[10px] leading-relaxed text-muted/80"
                  title={formatAcpAgentSpawn(activeAgent)}
                >
                  {formatAcpAgentSpawn(activeAgent)}
                </p>
              </div>
            ) : null}
            {orphanedSession ? (
              <div className="w-full max-w-full text-left">
                <OrphanedSessionCard
                  agent={activeAgent}
                  busy={starting}
                  onReclaim={() => void reclaimAndStart(activeAgentId)}
                  onStop={() => void stop(activeAgentId)}
                />
              </div>
            ) : (
              <>
                <p>{t("Start an ACP agent to begin a session.")}</p>
                <button
                  type="button"
                  onClick={start}
                  disabled={starting || !activeAgentId}
                  className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {starting ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {t("Starting…")}
                    </span>
                  ) : (
                    t("Start")
                  )}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {!ready && transcript.length > 0 ? (
              orphanedSession ? (
                <OrphanedSessionCard
                  agent={activeAgent}
                  busy={starting}
                  onReclaim={() => void reclaimAndStart(activeAgentId)}
                  onStop={() => void stop(activeAgentId)}
                />
              ) : (
                <div className="flex justify-center pb-1">
                  <button
                    type="button"
                    onClick={start}
                    disabled={starting || !activeAgentId}
                    className="rounded-md border border-border bg-surface px-3 py-1 text-xs font-medium text-text/88 hover:bg-accent/10 disabled:opacity-50"
                  >
                    {starting ? t("Starting…") : t("Restart agent")}
                  </button>
                </div>
              )
            ) : null}
            {transcript.map((entry) => (
              <TranscriptEntry
                key={entry.id}
                entry={entry}
                onRespondPermission={respondPermission}
              />
            ))}
            {turnActive ? (
              <div className="flex items-center gap-2 px-1 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t("Agent working…")}
              </div>
            ) : null}
            {ready && transcript.length === 0 ? (
              <div className="pt-8 text-center text-xs text-muted">
                {t("Session ready — message the agent to get started.")}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {plan && plan.length > 0 ? <PlanCard plan={plan} /> : null}

      <div className="relative shrink-0 border-t border-border/80">
        {commandSuggestions.length > 0 ? (
          <div className="absolute inset-x-3 bottom-full z-10 mb-1 overflow-hidden rounded-lg border border-border bg-panel shadow-lg">
            {commandSuggestions.map((command) => (
              <button
                key={command.name}
                type="button"
                onClick={() => setQuestion(`/${command.name} `)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/10"
              >
                <span className="shrink-0 font-mono font-medium text-accent">
                  /{command.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {command.description}
                  {command.inputHint ? ` · ${command.inputHint}` : ""}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={handleSend} className="px-3 py-3">
          {shellContext ? (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-surface/60 px-2 py-1.5 text-xs">
              <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
              <span className="shrink-0 font-medium text-text/88">
                {shellContext.sessionName}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                {formatShellContextPreview(shellContext.content)}
              </span>
              <span className="shrink-0 rounded bg-warm px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {Array.from(shellContext.content).length}
              </span>
              <button
                type="button"
                onClick={clearShellContext}
                aria-label={t("Remove terminal selection")}
                className="shrink-0 rounded p-0.5 text-muted hover:text-red-500"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((image) => (
                <div key={image.id} className="relative">
                  <img
                    src={image.previewUrl}
                    alt=""
                    className="h-12 w-12 rounded-md border border-border/60 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((prev) => prev.filter((item) => item.id !== image.id))
                    }
                    aria-label={t("Remove image")}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-panel p-0.5 text-muted hover:text-red-500"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {/* One bordered box holding the textarea and a footer strip, so the
              session-mode picker and send button read as part of the composer
              (images arrive by paste only — there is no attach button). */}
          <div className="overflow-visible rounded-[18px] border border-border/55 bg-surface/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors focus-within:border-accent/45">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  handleSend(event);
                }
              }}
              onPaste={(event) => {
                const files = event.clipboardData?.files;
                if (files && files.length > 0 && supportsImages) {
                  event.preventDefault();
                  void addImageFiles(files);
                }
              }}
              rows={2}
              disabled={!ready}
              placeholder={
                ready
                  ? t("Message the agent…")
                  : authActive
                    ? t("Sign in to continue")
                    : t("Start the agent first")
              }
              className="min-h-0 w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm leading-6 text-text outline-none placeholder:text-muted"
            />
            <div
              ref={composerMenuRef}
              className="relative flex items-end gap-1.5 border-t border-border/45 px-2 py-1.5"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {ready && modes?.availableModes?.length ? (
                  <AcpModePicker
                    modes={modes}
                    open={openMenu === "mode"}
                    onToggle={() => setOpenMenu((prev) => (prev === "mode" ? null : "mode"))}
                    onSelect={(modeId) => {
                      setMode(modeId);
                      setOpenMenu(null);
                    }}
                  />
                ) : null}
                {ready ? (
                  <AcpSessionSettingsMenu
                    options={sessionConfigOptions}
                    open={openMenu === "settings"}
                    onToggle={() =>
                      setOpenMenu((prev) => (prev === "settings" ? null : "settings"))
                    }
                    onSelect={(configId, value) => {
                      void setConfigOption(configId, value);
                      setOpenMenu(null);
                    }}
                  />
                ) : null}
              </div>
              {turnActive ? (
                <button
                  type="button"
                  onClick={cancelTurn}
                  title={t("Cancel turn")}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text/88 transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  title={t("Send")}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
