"use client";

import { useEffect, useState } from "react";
import { isTauri, isDesktop } from "@alook/shared";

export function TauriDragRegion() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(isTauri() && isDesktop());
  }, []);

  if (!show) return null;

  return (
    <div
      className="h-7 w-full shrink-0"
      onPointerDown={async (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri injects __TAURI__ globally at runtime
          const tauri = (window as any).__TAURI__;
          if (tauri) await tauri.window.getCurrentWindow().startDragging();
        } catch {}
      }}
    />
  );
}
