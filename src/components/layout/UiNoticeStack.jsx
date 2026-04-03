import { AlertTriangle, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";

const noticeToneClass = (tone) => {
  if (tone === "warning") {
    return {
      frame:
        "border-[#efc77a] bg-[#fff3d8] text-[#5f3e00] shadow-[0_18px_48px_rgba(138,90,0,0.2)]",
      icon: "text-[#8a5a00]",
      button:
        "border-[#e1b95d]/80 bg-[#ffecc3] text-[#8a5a00] hover:border-[#d2a84a] hover:bg-[#ffe3af]",
    };
  }
  if (tone === "info") {
    return {
      frame:
        "border-accent/45 bg-accent-soft/95 text-text shadow-[0_18px_48px_rgba(28,122,103,0.2)]",
      icon: "text-accent",
      button:
        "border-accent/30 bg-white/65 text-accent hover:border-accent/45 hover:bg-white/80",
    };
  }
  return {
    frame:
      "border-danger/55 bg-[#ffe9e4] text-[#6e2b20] shadow-[0_18px_48px_rgba(194,72,50,0.22)]",
    icon: "text-danger",
    button:
      "border-danger/30 bg-white/75 text-danger hover:border-danger/45 hover:bg-white",
  };
};

const NoticeIcon = ({ tone }) => {
  if (tone === "warning") {
    return <TriangleAlert className="h-4 w-4" aria-hidden="true" />;
  }
  if (tone === "info") {
    return <Info className="h-4 w-4" aria-hidden="true" />;
  }
  return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
};

export default function UiNoticeStack({ notices, onDismiss }) {
  const timersRef = useRef(new Map());

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
    <div className="pointer-events-none fixed inset-x-0 top-14 z-80 flex justify-center px-3 sm:px-6">
      <div className="w-full max-w-2xl space-y-2">
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
              className={[
                "pointer-events-auto rounded-2xl border px-3 py-2.5 backdrop-blur-[2px]",
                toneClass.frame,
              ].join(" ")}
              role="alert"
            >
              <div className="flex items-start gap-2">
                <span
                  className={[
                    "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current/20 bg-white/45",
                    toneClass.icon,
                  ].join(" ")}
                >
                  <NoticeIcon tone={tone} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] opacity-80">
                    {tone === "warning" ? "Operation Warning" : "Operation Error"}
                  </div>
                  <p className="mt-1 break-words text-sm leading-5">{text}</p>
                </div>
                <button
                  type="button"
                  className={[
                    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border transition-colors",
                    toneClass.button,
                  ].join(" ")}
                  onClick={() => onDismiss(notice.id)}
                  title="Dismiss"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
