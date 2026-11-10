"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { isTauri, isDesktop, tauriInvoke } from "@alook/shared";

export function readTauriWindowBackground(
  doc: Document = document,
): [number, number, number] | null {
  const published = doc.body?.style.getPropertyValue("--app-edge-fade-color").trim();
  if (!published) return null;
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "transparent";
    context.fillStyle = published;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return alpha === 255 ? [red, green, blue] : null;
  } catch {
    return null;
  }
}

export async function syncTauriWindowTheme(dark: boolean, background: [number, number, number] | null = null) {
  try {
    await tauriInvoke("set_window_theme", { dark, ...(background ? { background } : {}) });
  } finally {
    await tauriInvoke("close_splashscreen").catch(() => {});
  }
}

export function TauriThemeSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!isTauri() || !isDesktop()) return;
    if (!resolvedTheme) return;

    const sync = () => {
      void syncTauriWindowTheme(resolvedTheme === "dark", readTauriWindowBackground()).catch(() => {});
    };
    window.addEventListener("alook:theme-color-change", sync);
    sync();
    return () => window.removeEventListener("alook:theme-color-change", sync);
  }, [resolvedTheme]);

  return null;
}
