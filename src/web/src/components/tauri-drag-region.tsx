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
      className="fixed top-0 left-0 right-0 h-7 z-[9999]"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const tauri = (window as any).__TAURI__;
        if (tauri?.window?.getCurrentWindow) {
          tauri.window.getCurrentWindow().startDragging();
        }
      }}
    />
  );
}
