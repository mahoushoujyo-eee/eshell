import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Lightweight resizable split panel component.
 * `direction`:
 * - "horizontal": left/right split.
 * - "vertical": top/bottom split.
 */
export default function SplitPane({
  direction = "horizontal",
  initialRatio = 0.3,
  minPrimarySize = 220,
  minSecondarySize = 220,
  collapsed = false,
  collapsedPrimarySize = 0,
  collapseSecondary = false,
  collapsedSecondarySize = 0,
  primary,
  secondary,
  className = "",
}) {
  const containerRef = useRef(null);
  const [ratio, setRatio] = useState(initialRatio);
  const [dragging, setDragging] = useState(false);

  const isHorizontal = direction === "horizontal";

  useEffect(() => {
    if (collapsed || collapseSecondary) {
      setDragging(false);
    }
  }, [collapsed, collapseSecondary]);

  useEffect(() => {
    if (!dragging) {
      return undefined;
    }

    const onMouseMove = (event) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const total = isHorizontal ? rect.width : rect.height;
      if (total <= 0) {
        return;
      }

      const cursor = isHorizontal
        ? event.clientX - rect.left
        : event.clientY - rect.top;

      const minPrimaryRatio = Math.min(1, minPrimarySize / total);
      const maxPrimaryRatio = Math.max(0, 1 - minSecondarySize / total);
      const next = cursor / total;
      const bounded = Math.min(maxPrimaryRatio, Math.max(minPrimaryRatio, next));
      setRatio(bounded);
    };

    const onMouseUp = () => {
      setDragging(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, isHorizontal, minPrimarySize, minSecondarySize]);

  const primaryBasis = useMemo(() => `${(ratio * 100).toFixed(3)}%`, [ratio]);
  const secondaryBasis = useMemo(
    () => `${((1 - ratio) * 100).toFixed(3)}%`,
    [ratio],
  );

  const primaryFlexBasis = collapsed
    ? `${collapsedPrimarySize}px`
    : collapseSecondary
      ? "auto"
      : primaryBasis;
  const primaryFlexGrow = collapsed ? 0 : collapseSecondary ? 1 : 0;
  const secondaryFlexBasis = collapseSecondary
    ? `${collapsedSecondarySize}px`
    : secondaryBasis;
  const secondaryFlexGrow = collapseSecondary ? 0 : 1;

  return (
    <div
      ref={containerRef}
      className={[
        "flex h-full w-full overflow-hidden",
        isHorizontal ? "flex-row" : "flex-col",
        className,
      ].join(" ")}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{
          flexBasis: primaryFlexBasis,
          flexGrow: primaryFlexGrow,
          flexShrink: 0,
          transition: "flex-basis 220ms ease",
        }}
      >
        {primary}
      </div>

      <button
        type="button"
        aria-label={isHorizontal ? "Resize columns" : "Resize rows"}
        className={[
          "relative shrink-0 bg-border/80 transition-colors",
          collapsed || collapseSecondary ? "pointer-events-none opacity-0" : "",
          isHorizontal
            ? "w-px cursor-col-resize hover:bg-accent/80"
            : "h-px cursor-row-resize hover:bg-accent/80",
        ].join(" ")}
        onMouseDown={() => {
          if (!collapsed && !collapseSecondary) {
            setDragging(true);
          }
        }}
      />

      <div
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{
          flexBasis: secondaryFlexBasis,
          flexGrow: secondaryFlexGrow,
          flexShrink: 0,
          transition: "flex-basis 220ms ease",
        }}
      >
        {secondary}
      </div>
    </div>
  );
}
