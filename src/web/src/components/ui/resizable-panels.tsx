"use client";

import {
  useRef,
  useCallback,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";

export interface PanelConfig {
  /** Default width in px. Omit (or set 0) for the flex panel. */
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  children: ReactNode;
  className?: string;
}

interface ResizablePanelsProps {
  panels: PanelConfig[];
  /** localStorage key for persisting widths */
  storageKey: string;
}

export function ResizablePanels({ panels, storageKey }: ResizablePanelsProps) {
  const defaults = panels.map((p) => p.defaultWidth ?? 0);
  const [widths, setWidths] = useLocalStorage<number[]>(storageKey, defaults);

  // Ensure stored array length matches panels
  const safeWidths =
    widths.length === panels.length ? widths : defaults;

  const dragging = useRef<{
    index: number;
    startX: number;
    startLeft: number;
    startRight: number;
  } | null>(null);

  const handlePointerDown = useCallback(
    (dividerIndex: number, e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragging.current = {
        index: dividerIndex,
        startX: e.clientX,
        startLeft: safeWidths[dividerIndex],
        startRight: safeWidths[dividerIndex + 1],
      };
    },
    [safeWidths]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const { index, startX, startLeft, startRight } = dragging.current;
      const delta = e.clientX - startX;

      const leftPanel = panels[index];
      const rightPanel = panels[index + 1];
      const minL = leftPanel.minWidth ?? 60;
      const maxL = leftPanel.maxWidth ?? Infinity;
      const minR = rightPanel.minWidth ?? 60;
      const maxR = rightPanel.maxWidth ?? Infinity;

      // If right panel is the flex panel (defaultWidth 0), only resize left
      if ((rightPanel.defaultWidth ?? 0) === 0) {
        const newLeft = Math.max(minL, Math.min(maxL, startLeft + delta));
        setWidths((prev) => {
          const next = [...(prev.length === panels.length ? prev : defaults)];
          next[index] = newLeft;
          return next;
        });
        return;
      }

      // Both fixed panels — redistribute
      let newLeft = startLeft + delta;
      let newRight = startRight - delta;

      if (newLeft < minL) { newLeft = minL; newRight = startLeft + startRight - minL; }
      if (newLeft > maxL) { newLeft = maxL; newRight = startLeft + startRight - maxL; }
      if (newRight < minR) { newRight = minR; newLeft = startLeft + startRight - minR; }
      if (newRight > maxR) { newRight = maxR; newLeft = startLeft + startRight - maxR; }

      setWidths((prev) => {
        const next = [...(prev.length === panels.length ? prev : defaults)];
        next[index] = newLeft;
        next[index + 1] = newRight;
        return next;
      });
    },
    [panels, defaults, setWidths]
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  return (
    <div
      className="flex flex-1 min-h-0"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {panels.map((panel, i) => {
        const isFlex = (panel.defaultWidth ?? 0) === 0;
        const style: CSSProperties = isFlex
          ? { flex: 1, minWidth: 0, overflow: "auto" }
          : { width: safeWidths[i], flexShrink: 0 };

        return (
          <div key={i} className="flex min-h-0" style={isFlex ? { flex: 1, minWidth: 0 } : undefined}>
            <div style={style} className={panel.className}>
              {panel.children}
            </div>
            {i < panels.length - 1 && (
              <div
                onPointerDown={(e) => handlePointerDown(i, e)}
                className="relative w-0 shrink-0 cursor-col-resize group z-10"
              >
                {/* Visible line */}
                <div className="absolute inset-y-0 -left-px w-px bg-border/40 group-hover:bg-border transition-colors" />
                {/* Wider hit area */}
                <div className="absolute inset-y-0 -left-1.5 w-3" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface ResizeHandleProps {
  onResize: (delta: number) => void;
  className?: string;
  direction?: "left" | "right";
}

export function ResizeHandle({ onResize, className, direction = "right" }: ResizeHandleProps) {
  const dragging = useRef(false);
  const startX = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragging.current = true;
      startX.current = e.clientX;
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      startX.current = e.clientX;
      onResize(direction === "left" ? -delta : delta);
    },
    [onResize, direction]
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={className ?? "absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-primary/20 active:bg-primary/30 transition-colors"}
    />
  );
}
