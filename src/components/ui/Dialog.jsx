import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../lib/i18n";
import { cx } from "./cx";
import { IconButton } from "./Button";

// Open dialogs, innermost last. Only the top one answers Escape, so closing a
// confirmation opened from Settings does not close Settings too.
const openDialogs = [];

const LAYERS = {
  modal: "z-50",
  stacked: "z-[60]",
  critical: "z-[70]",
};

// Any other `size` (e.g. "custom") leaves the width to `className`.
const SIZES = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

/**
 * Modal shell: overlay, elevated panel, Escape and overlay-click handling.
 *
 * It imposes no inner layout or scrolling — compose `DialogHeader`,
 * `DialogBody` and `DialogFooter`, or lay the panel out directly. With
 * `dismissible={false}` (a request in flight, a decision that must be made
 * explicitly) neither Escape nor the overlay closes it; `closeOnOverlay={false}`
 * keeps Escape but ignores stray overlay clicks.
 */
export default function Dialog({
  open,
  onClose,
  dismissible = true,
  closeOnOverlay = true,
  layer = "modal",
  size = "md",
  labelledBy,
  describedBy,
  className = "",
  children,
}) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  }, [onClose, dismissible]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const token = { panel: panelRef.current };
    // Effects run child-first, so a dialog mounted together with one nested
    // inside it registers after its child; slot it underneath instead.
    const nestedIndex = openDialogs.findIndex(
      (other) => token.panel && other.panel && token.panel.contains(other.panel),
    );
    if (nestedIndex >= 0) {
      openDialogs.splice(nestedIndex, 0, token);
    } else {
      openDialogs.push(token);
    }
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || openDialogs[openDialogs.length - 1] !== token) {
        return;
      }
      if (!dismissibleRef.current) {
        return;
      }
      event.preventDefault();
      onCloseRef.current?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const index = openDialogs.indexOf(token);
      if (index >= 0) {
        openDialogs.splice(index, 1);
      }
    };
  }, [open]);

  // Move focus into the dialog unless a child (an autofocused field) already
  // took it, so keyboard users start inside the modal.
  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    if (!panel || typeof panel.focus !== "function") {
      return;
    }
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active && typeof panel.contains === "function" && panel.contains(active)) {
      return;
    }
    panel.focus({ preventScroll: true });
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className={cx(
        "fixed inset-0 flex items-center justify-center bg-black/45 p-4 animate-[es-fade-in_120ms_ease-out] dark:bg-black/60",
        LAYERS[layer] || LAYERS.modal,
      )}
      onClick={dismissible && closeOnOverlay ? () => onCloseRef.current?.() : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className={cx(
          "flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-elevated text-text shadow-overlay outline-none animate-[es-dialog-in_140ms_ease-out]",
          SIZES[size] || "",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// Tone only tints the icon; a filled chip behind it competes with the title
// and repeats on every dialog in the app.
const HEADER_ICON_TONES = {
  default: "text-muted",
  accent: "text-accent",
  danger: "text-danger",
  warning: "text-warning",
};

/**
 * Title row. `description` sits under the title; `onClose` adds the close
 * button (omit it for dialogs that must be answered explicitly).
 */
export function DialogHeader({
  icon: Icon,
  tone = "default",
  title,
  titleId,
  description,
  actions,
  onClose,
  closeDisabled = false,
  className = "",
}) {
  const { t } = useI18n();
  return (
    <div className={cx("flex shrink-0 items-start gap-3 border-b border-border px-4 py-3", className)}>
      {Icon ? (
        <span
          className={cx(
            "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center",
            HEADER_ICON_TONES[tone] || HEADER_ICON_TONES.default,
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1 self-center">
        <h3 id={titleId} className="truncate text-sm font-semibold text-text">
          {title}
        </h3>
        {description ? <div className="mt-0.5 text-xs leading-relaxed text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5 self-center">{actions}</div> : null}
      {onClose ? (
        <IconButton
          label={t("Close")}
          size="sm"
          className="-mr-1 self-center"
          onClick={onClose}
          disabled={closeDisabled}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}

export function DialogBody({ className = "", children }) {
  return <div className={cx("scroll-region min-h-0 flex-1 overflow-y-auto px-4 py-4", className)}>{children}</div>;
}

export function DialogFooter({ className = "", children }) {
  return (
    <div className={cx("flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3", className)}>
      {children}
    </div>
  );
}
