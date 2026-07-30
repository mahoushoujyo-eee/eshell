import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Renders `children` into a self-owned DOM node (host) and parks that node
 * inside a stable slot node while `active` is true, or in a hidden detached
 * container while false. Both host and slot live outside React's
 * reconciliation, so panel toggles never unmount the component tree — local
 * state (open folders, drafts, scroll position) is preserved.
 *
 * The slot node is exposed via `slotRef` for the parent to position in its
 * layout. The parent must render a plain container and move `slotRef.current`
 * into it; this component handles the rest.
 *
 * Host/slot moves run in useLayoutEffect to avoid paint flashes.
 */
export default function KeepAlive({ active, slotRef, children }) {
  const hostRef = useRef(null);
  const stashRef = useRef(null);

  if (hostRef.current === null && typeof document !== "undefined") {
    hostRef.current = document.createElement("div");
    hostRef.current.className = "h-full w-full";
  }

  // Runs after every render (not just on `active` change): the slot node can
  // be detached and re-attached elsewhere by the layout, and the host must
  // follow it. The checks are idempotent, so re-running is cheap.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const slot = slotRef?.current;
    if (!host || !slot) {
      return;
    }

    if (active) {
      if (host.parentNode !== slot) {
        slot.appendChild(host);
      }
      host.style.display = "";
      slot.style.display = "";
    } else {
      if (!stashRef.current) {
        stashRef.current = document.createElement("div");
        stashRef.current.style.display = "none";
        document.body.appendChild(stashRef.current);
      }
      if (host.parentNode !== stashRef.current) {
        stashRef.current.appendChild(host);
      }
      host.style.display = "none";
      slot.style.display = "none";
    }
  });

  useEffect(
    () => () => {
      hostRef.current?.remove();
      stashRef.current?.remove();
      stashRef.current = null;
    },
    [],
  );

  return hostRef.current ? createPortal(children, hostRef.current) : null;
}
