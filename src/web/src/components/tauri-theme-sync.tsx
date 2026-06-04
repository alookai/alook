"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { isTauri, isDesktop, tauriInvoke } from "@alook/shared";

export function TauriThemeSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!isTauri() || !isDesktop()) return;
    if (!resolvedTheme) return;

    tauriInvoke("set_window_theme", { dark: resolvedTheme === "dark" }).catch(
      () => {},
    );
  }, [resolvedTheme]);

  return null;
}
