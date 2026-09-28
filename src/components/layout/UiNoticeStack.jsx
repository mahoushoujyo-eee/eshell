import { AlertTriangle, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../lib/i18n";

const noticeToneClass = (tone) => {
  if (tone === "success") {
    return { bar: "bg-success", icon: "text-success" };
  }
  if (tone === "warning") {
    return { bar: "bg-warning", icon: "text-warning" };
  }
  if (tone === "info") {
    return { bar: "bg-info", icon: "text-info" };
  }
  return { bar: "bg-danger", icon: "text-danger" };
};

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

        const toneClass = noticeToneClass(tone);
        return (
          <section
            key={notice.id}
            className="pointer-events-auto relative overflow-hidden rounded-lg border border-border bg-elevated py-2.5 pr-2 pl-4 text-text shadow-overlay animate-[es-dialog-in_160ms_ease-out]"
            role={tone === "danger" || tone === "warning" ? "alert" : "status"}
          >
            <span className={["absolute inset-y-0 left-0 w-[3px]", toneClass.bar].join(" ")} aria-hidden="true" />
            <div className="flex items-start gap-2.5">
              <span className={["mt-0.5 shrink-0", toneClass.icon].join(" ")}>
                <NoticeIcon tone={tone} />
              </span>
              <div className="min-w-0 flex-1">
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
