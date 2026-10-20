import { useState } from "react";
import { ExternalLink, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../lib/i18n";

const NODE_DOWNLOAD_URL = "https://nodejs.org/";

const probedTools = (env) => [env?.node, env?.npx].filter(Boolean);

/**
 * Standing card shown while the built-in agents cannot start at all, so the
 * user is told what is missing instead of being left to read a spawn error.
 * It stays up after a failed start: the notice row says what happened, this
 * says what to do about it.
 */
export default function AcpEnvWarningCard({ env, onRecheck }) {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);

  const missing = probedTools(env).filter((tool) => !tool.found);
  const installed = probedTools(env).filter((tool) => tool.found);

  const recheck = async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      window.setTimeout(() => setChecking(false), 400);
    }
  };

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-left">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 flex-none text-warning" aria-hidden="true" />
        <span className="text-xs font-semibold text-text">{t("Node.js is required")}</span>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {t(
          "The built-in agents are launched through npx, so they cannot start without Node.js. Install it, then re-check — no need to restart eShell.",
        )}
      </p>

      <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
        {missing.map((tool) => (
          <li key={tool.command} className="flex items-center justify-between gap-2">
            <span className="text-text/88">{tool.command}</span>
            <span className="text-warning">{t("not found")}</span>
          </li>
        ))}
        {installed.map((tool) => (
          <li key={tool.command} className="flex items-center justify-between gap-2">
            <span className="text-text/88">{tool.command}</span>
            <span className="text-muted">{tool.version || t("installed")}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void openUrl(NODE_DOWNLOAD_URL)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent hover:bg-accent/88"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          {t("Download Node.js")}
        </button>
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-[11px] font-medium text-text/88 hover:bg-hover disabled:opacity-50"
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t("Re-check")}
        </button>
      </div>

      <p className="mt-1.5 text-[10px] text-subtle">{NODE_DOWNLOAD_URL}</p>
    </div>
  );
}
