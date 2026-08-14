"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { isTauri, isDesktop, tauriInvoke } from "@alook/shared";

export async function syncTauriWindowTheme(dark: boolean) {
  try {
    await tauriInvoke("set_window_theme", { dark });
  } finally {
    await tauriInvoke("close_splashscreen").catch(() => {});
  }
}

export function TauriThemeSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!isTauri() || !isDesktop()) return;
    if (!resolvedTheme) return;

    void syncTauriWindowTheme(resolvedTheme === "dark").catch(() => {});
  }, [resolvedTheme]);

  return null;
}
