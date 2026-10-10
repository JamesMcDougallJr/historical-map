"use client";

// A phone bottom sheet with three snap points, built in-house (no libraries,
// plans/19 decision 8) and deliberately simple: CSS heights with a height
// transition, and a drag handle that follows the finger and snaps to the
// *nearest* point on release. No inertia, no rubber-banding — if those ever
// become necessary, that is the point to reconsider a library.
//
// `touch-action: none` is on the handle only, so the body scrolls natively
// and the map never sees the drag; the handle also stops propagation, so a
// sheet drag can't pan the map underneath.

import { useCallback, useRef, useState, type ReactNode } from "react";

export type SheetSnap = "peek" | "half" | "full";

/** Fractions of the visible viewport height. */
const SNAP_FRACTION: Record<SheetSnap, number> = {
  peek: 0.18,
  half: 0.5,
  full: 0.92,
};

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

export function BottomSheet({
  snap,
  onSnapChange,
  children,
  label,
}: {
  snap: SheetSnap;
  onSnapChange(snap: SheetSnap): void;
  children: ReactNode;
  label: string;
}): JSX.Element {
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const startRef = useRef<{ y: number; height: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers (some test drivers) can't be captured; the drag
        // still works while the pointer stays over the handle.
      }
      startRef.current = {
        y: e.clientY,
        height: SNAP_FRACTION[snap] * viewportHeight(),
      };
      setDragHeight(startRef.current.height);
    },
    [snap],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    e.stopPropagation();
    const vh = viewportHeight();
    const next = Math.min(
      vh,
      Math.max(48, start.height + (start.y - e.clientY)),
    );
    setDragHeight(next);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start) return;
      e.stopPropagation();
      const vh = viewportHeight();
      const height = dragHeight ?? start.height;
      let nearest: SheetSnap = snap;
      let best = Infinity;
      for (const [name, fraction] of Object.entries(SNAP_FRACTION) as Array<
        [SheetSnap, number]
      >) {
        const distance = Math.abs(fraction * vh - height);
        if (distance < best) {
          best = distance;
          nearest = name;
        }
      }
      setDragHeight(null);
      onSnapChange(nearest);
    },
    [dragHeight, snap, onSnapChange],
  );

  return (
    <div
      role="dialog"
      aria-label={label}
      data-testid="bottom-sheet"
      data-snap={snap}
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl bg-white dark:bg-slate-900 shadow-2xl border-t border-slate-200 dark:border-slate-700"
      style={{
        height:
          dragHeight !== null
            ? `${dragHeight}px`
            : `${SNAP_FRACTION[snap] * 100}dvh`,
        transition: dragHeight !== null ? "none" : "height 200ms ease-out",
      }}
    >
      <div
        className="flex h-11 shrink-0 cursor-grab items-center justify-center"
        style={{ touchAction: "none" }}
        data-testid="bottom-sheet-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="block h-1.5 w-10 rounded-full bg-slate-300" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {children}
      </div>
    </div>
  );
}
