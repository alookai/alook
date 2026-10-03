"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useRef, useEffect, useCallback } from "react";

export function MockNetworkBanner() {
  const enabled =
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_MOCK_NETWORK === "true";
  const delayMs = process.env.NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS || "300";

  const [position, setPosition] = useAtom(useCreateAtom<{ x: number; y: number } | null>(null));
  const [mounted, setMounted] = useAtom(useCreateAtom(false));

  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPosition({ x: window.innerWidth - 220, y: window.innerHeight - 56 });
    setMounted(true);
  }, [setMounted, setPosition]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    offset.current = {
      x: e.clientX - (position?.x ?? 0),
      y: e.clientY - (position?.y ?? 0),
    };
    pillRef.current?.setPointerCapture(e.pointerId);
  }, [position]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const newX = Math.max(0, Math.min(e.clientX - offset.current.x, window.innerWidth - 40));
    const newY = Math.max(0, Math.min(e.clientY - offset.current.y, window.innerHeight - 40));
    setPosition({ x: newX, y: newY });
  }, [setPosition]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!enabled || !mounted) return null;

  return (
    <div
      ref={pillRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "fixed",
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        zIndex: 9999,
        height: "32px",
        borderRadius: "16px",
        backgroundColor: "#ef4444",
        color: "#ffffff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 12px",
        fontSize: "12px",
        fontWeight: 600,
        cursor: "grab",
        userSelect: "none",
        touchAction: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        whiteSpace: "nowrap",
      }}
    >
      Mock Network — {delayMs}ms delay
    </div>
  );
}
