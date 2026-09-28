import { AlertTriangle, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../lib/i18n";

// Each tone tints the card with an ambient glow behind its icon plus a faint
// same-hue border and halo, rather than a hard colour stripe.
const NOTICE_TONES = {
  success: { color: "var(--es-success)", icon: "text-success", border: "border-success/25" },
  warning: { color: "var(--es-warning)", icon: "text-warning", border: "border-warning/30" },
  info: { color: "var(--es-info)", icon: "text-info", border: "border-info/25" },
  danger: { color: "var(--es-danger)", icon: "text-danger", border: "border-danger/30" },
};

const noticeTone = (tone) => NOTICE_TONES[tone] || NOTICE_TONES.danger;

const NoticeIcon = ({ tone }) => {
  if (tone === "success") {
    return <CircleCheck className="h-4 w-4" aria-hidden="true" />;
  }
  if (tone === "warning") {
    return <TriangleAlert className="h-4 w-4" aria-hidden="true" />;
  }
  if (tone === "info") {
    return <Info className="h-4 w-4" aria-hidden="true" />;
  }
  return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
};

export default function UiNoticeStack({ notices, onDismiss }) {
  const { t } = useI18n();
  const timersRef = useRef(new Map());

  const titleByTone = {
    success: t("Operation Complete"),
    info: t("Operation Update"),
    warning: t("Operation Warning"),
    danger: t("Operation Error"),
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const activeIds = new Set();

    notices.forEach((notice) => {
      if (!notice?.id) {
        return;
      }
      activeIds.add(notice.id);

      const ttl = Number(notice.ttlMs);
      if (!Number.isFinite(ttl) || ttl <= 0 || timersRef.current.has(notice.id)) {
        return;
      }

      const timer = window.setTimeout(() => {
        timersRef.current.delete(notice.id);
        onDismiss(notice.id);
      }, ttl);
      timersRef.current.set(notice.id, timer);
    });

    timersRef.current.forEach((timer, id) => {
      if (activeIds.has(id)) {
        return;
      }
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    });

    return undefined;
  }, [notices, onDismiss]);

  useEffect(
    () => () => {
      if (typeof window === "undefined") {
        return;
      }
      timersRef.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      timersRef.current.clear();
    },
    [],
  );

  if (!Array.isArray(notices) || notices.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-3 bottom-9 z-80 flex w-[min(380px,calc(100vw-1.5rem))] flex-col gap-2">
      {notices.map((notice) => {
        const tone = notice?.tone || "danger";
        const text = String(notice?.message || "").trim();
        if (!notice?.id || !text) {
          return null;
        }

        const toneStyle = noticeTone(tone);
        return (
          <section
            key={notice.id}
            className={[
              "pointer-events-auto relative isolate overflow-hidden rounded-xl border bg-elevated py-2.5 pr-2 pl-3 text-text animate-[es-dialog-in_160ms_ease-out]",
              toneStyle.border,
            ].join(" ")}
            style={{
              boxShadow: `var(--es-shadow), 0 10px 32px -12px color-mix(in srgb, ${toneStyle.color} 55%, transparent)`,
            }}
            role={tone === "danger" || tone === "warning" ? "alert" : "status"}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-12 -left-10 -z-10 h-32 w-32 rounded-full opacity-20 blur-2xl dark:opacity-30"
              style={{ background: toneStyle.color }}
            />
            <div className="flex items-start gap-2.5">
              <span
                className={[
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                  toneStyle.icon,
                ].join(" ")}
                style={{ background: `color-mix(in srgb, ${toneStyle.color} 14%, transparent)` }}
              >
                <NoticeIcon tone={tone} />
              </span>
              <div className="min-w-0 flex-1 pt-px">
                <div className="text-xs font-semibold text-text">
                  {titleByTone[tone] || titleByTone.danger}
                </div>
                <p className="mt-0.5 break-words text-xs leading-5 text-muted">{text}</p>
              </div>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
                onClick={() => onDismiss(notice.id)}
                title={t("Dismiss")}
                aria-label={t("Dismiss")}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
