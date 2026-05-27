"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MAX_WIDTH_RATIO = 0.8;
const DEFAULT_WIDTH = 480;

export function useSheetResize({
  defaultWidth = DEFAULT_WIDTH,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidthRatio = DEFAULT_MAX_WIDTH_RATIO,
}: {
  defaultWidth?: number;
  minWidth?: number;
  maxWidthRatio?: number;
} = {}) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const maxW = window.innerWidth * maxWidthRatio;
      setWidth(Math.min(maxW, Math.max(minWidth, window.innerWidth - e.clientX)));
    },
    [minWidth, maxWidthRatio]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return { width, onPointerDown, onPointerMove, onPointerUp };
}

export function SheetResizeHandle({
  onPointerDown,
  onPointerMove,
  onPointerUp,
  className,
  withHandle = true,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  className?: string;
  withHandle?: boolean;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onPointerUp}
      className={cn(
        "hidden sm:flex absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 items-center justify-center hover:bg-primary/10 active:bg-primary/20 transition-colors rounded-l-xl",
        className
      )}
    >
      {withHandle && <div className="h-6 w-1 rounded-lg bg-border" />}
    </div>
  );
}
