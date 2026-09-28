import { AlertTriangle, CircleCheck, FolderOpen, LoaderCircle, Sparkles } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cx } from "../ui/cx";

const TONE_TEXT = {
  muted: "text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

function StatusItem({ icon: Icon, tone = "muted", title, spin = false, mono = false, className = "", children }) {
  return (
    <div
      className={cx("inline-flex h-full min-w-0 items-center gap-1.5 px-2", TONE_TEXT[tone], className)}
      title={title}
    >
      {Icon ? (
        <Icon className={cx("h-3 w-3 shrink-0", spin ? "animate-spin" : "")} aria-hidden="true" />
      ) : null}
      <span className={cx("truncate", mono ? "font-mono text-[10.5px]" : "")}>{children}</span>
    </div>
  );
}

/**
 * Bottom status bar: the active session's endpoint and directory on the
 * left, background activity and the latest issue on the right.
 */
export default function StatusBar({
  activeSession,
  sshConfigs = [],
  disconnectedSessions = {},
  busy,
  error,
  isAiStreaming = false,
}) {
  const { t } = useI18n();

  const hasError = Boolean(error && String(error).trim());
  const normalizedError = hasError ? String(error).trim() : "";
  const isWarning =
    hasError &&
    (/^warning/i.test(normalizedError) ||
      normalizedError ===
        t(
          "Warning: Server status polling failed for this cycle due to a transient network fluctuation. The app will retry automatically.",
        ));
  const busyText = busy ? t("Running: {busy}", { busy }) : t("Idle");
  const errorText = hasError ? (isWarning ? t("Background warning") : t("Recent issue")) : t("No issues");

  const config = activeSession
    ? sshConfigs.find((item) => item?.id === activeSession.configId) || null
    : null;
  const endpoint =
    config && config.host
      ? `${config.username ? `${config.username}@` : ""}${config.host}${
          config.port && Number(config.port) !== 22 ? `:${config.port}` : ""
        }`
      : "";
  const disconnected = Boolean(activeSession && disconnectedSessions[activeSession.id]);

  return (
    <footer className="flex h-6 shrink-0 items-center border-t border-border bg-bg pr-1 text-[11px] text-muted select-none">
      {activeSession ? (
        <>
          <div
            className={cx(
              "inline-flex h-full min-w-0 shrink-0 items-center gap-1.5 px-2.5",
              disconnected ? "bg-danger/12 text-danger" : "bg-accent-soft text-accent",
            )}
            title={disconnected ? t("Session disconnected") : endpoint || activeSession.configName}
          >
            <span
              className={cx("h-1.5 w-1.5 shrink-0 rounded-full", disconnected ? "bg-danger" : "bg-accent")}
              aria-hidden="true"
            />
            <span className="max-w-[180px] truncate font-medium">{activeSession.configName}</span>
          </div>
          {endpoint ? (
            <StatusItem mono title={endpoint} className="max-w-[240px]">
              {endpoint}
            </StatusItem>
          ) : null}
          {activeSession.currentDir ? (
            <StatusItem icon={FolderOpen} mono title={activeSession.currentDir} className="max-w-[40%]">
              {activeSession.currentDir}
            </StatusItem>
          ) : null}
        </>
      ) : (
        <StatusItem>{t("No active sessions")}</StatusItem>
      )}

      <div className="ml-auto flex h-full min-w-0 items-center">
        {isAiStreaming ? (
          <StatusItem icon={Sparkles} tone="accent">
            {t("AI responding")}
          </StatusItem>
        ) : null}
        <StatusItem
          icon={busy ? LoaderCircle : null}
          tone={busy ? "accent" : "muted"}
          spin={Boolean(busy)}
          title={busyText}
          className="max-w-[260px]"
        >
          {busyText}
        </StatusItem>
        <StatusItem
          icon={hasError ? AlertTriangle : CircleCheck}
          tone={hasError ? (isWarning ? "warning" : "danger") : "muted"}
          title={hasError ? normalizedError : errorText}
        >
          {errorText}
        </StatusItem>
      </div>
    </footer>
  );
}
