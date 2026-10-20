import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../../lib/i18n";
import { copyTextToClipboard } from "../../../utils/clipboard";

const NOTICE_TONES = {
  success: { color: "var(--es-success)", border: 25 },
  warning: { color: "var(--es-warning)", border: 30 },
  info: { color: "var(--es-info)", border: 25 },
  danger: { color: "var(--es-danger)", border: 30 },
};

const NOTICE_ICONS = { info: Info, warning: TriangleAlert, error: AlertTriangle };

const NODE_DOWNLOAD_URL = "https://nodejs.org/";
// Beyond this the raw error is collapsed: the card is a summary, the detail
// is there for whoever needs to read it.
const NOTICE_COLLAPSE_AFTER = 220;

/**
 * One notice in the transcript. Errors get a card with a title, the raw
 * detail and the tools to act on it; anything quieter stays a line of text
 * so it does not interrupt reading.
 */
export default function AcpNoticeRow({ entry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);

  const detail = String(entry.detail || "");
  const tone = NOTICE_TONES[entry.tone] || NOTICE_TONES.danger;
  const Icon = NOTICE_ICONS[entry.tone] || Info;
  const isError = entry.tone === "error";

  const copy = noticeCopy(t, entry.code, detail);
  const longBody = copy.body.length > NOTICE_COLLAPSE_AFTER;
  const visibleBody =
    longBody && !expanded ? `${copy.body.slice(0, NOTICE_COLLAPSE_AFTER)}…` : copy.body;
  const hasBody = Boolean(copy.body);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onCopy = async () => {
    const ok = await copyTextToClipboard(hasBody ? `${copy.title}: ${copy.body}` : copy.title);
    if (!ok) {
      return;
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  // A body-less non-error notice is a line of context, not a card: a card has
  // a border and a background and would interrupt reading for no reason.
  if (!hasBody && !isError) {
    return copy.title ? (
      <p className="py-0.5 text-center text-[11px] text-muted">{copy.title}</p>
    ) : null;
  }

  return (
    <section
      role={isError ? "alert" : "status"}
      className="relative isolate overflow-hidden rounded-xl border bg-elevated p-2 text-text"
      style={{
        borderColor: `color-mix(in srgb, ${tone.color} ${tone.border}%, transparent)`,
        boxShadow: `var(--shadow-overlay), 0 10px 32px -12px color-mix(in srgb, ${tone.color} 55%, transparent)`,
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -left-10 -top-12 -z-10 h-32 w-32 rounded-full opacity-20 blur-3xl"
        style={{ background: tone.color }}
      />
      <div className="flex items-start gap-2.5">
        <span
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${tone.color} 14%, transparent)`,
            color: tone.color,
          }}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1 pt-px">
          <p className="text-xs font-semibold leading-[1.125rem] text-text">{copy.title}</p>
          {hasBody ? (
            <p className="mt-0.5 font-mono text-[11px] leading-[1.0625rem] text-muted wrap-anywhere">
              {visibleBody}
            </p>
          ) : null}
          {longBody && !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-0.5 text-[11px] font-semibold text-accent hover:underline"
            >
              {t("Show details")}
            </button>
          ) : null}
        </div>

        <div className="flex flex-none items-center gap-0.5">
          {entry.code === "env-missing" ? (
            <button
              type="button"
              title={NODE_DOWNLOAD_URL}
              onClick={() => void openUrl(NODE_DOWNLOAD_URL)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-accent hover:bg-hover"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t("Get Node.js")}</span>
            </button>
          ) : isError && hasBody ? (
            <button
              type="button"
              title={t("Copy")}
              aria-label={t("Copy")}
              onClick={onCopy}
              className="inline-flex h-6 items-center rounded-md px-1.5 text-muted hover:bg-hover hover:text-text"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** The body equals `detail` when the raw error is what should be shown. */
export function noticeCopy(t, code, detail) {
  switch (code) {
    case "session-ended":
      return { title: t("Session ended"), body: "" };
    case "env-missing":
      return {
        title: t("Node.js is not available"),
        body: t(
          "Could not find {tools} on this machine. The built-in agents are launched through npx and cannot start until Node.js is installed.",
          { tools: detail },
        ),
      };
    case "start-failed":
      return { title: t("Failed to start agent"), body: detail };
    case "new-session-failed":
      return { title: t("Failed to start a new session"), body: detail };
    case "project-create-failed":
      return { title: t("Failed to add project"), body: detail };
    case "project-delete-failed":
      return { title: t("Failed to remove project"), body: detail };
    case "turn-stopped":
      if (detail === "cancelled") return { title: t("Turn cancelled"), body: "" };
      if (detail === "refusal") return { title: t("The agent declined this request"), body: "" };
      if (detail === "max_tokens") return { title: t("Stopped: max tokens reached"), body: "" };
      return { title: t("Turn stopped"), body: detail };
    case "turn-failed":
      return { title: t("Turn failed"), body: detail };
    case "auth-failed":
      return { title: t("Sign-in failed"), body: detail };
    case "resume-fallback":
      return {
        title: t("History was not restored"),
        body: t(
          "This agent cannot restore the previous context; a fresh session was created instead.",
        ),
      };
    case "mode-failed":
      return { title: t("Failed to switch mode"), body: detail };
    case "config-option-failed":
      return { title: t("Failed to change setting"), body: detail };
    case "permission-failed":
      return { title: t("Failed to respond to permission request"), body: detail };
    case "agent-error":
      return { title: t("Agent error"), body: detail };
    default:
      return { title: detail, body: "" };
  }
}
