"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";

const TRANSPARENT_COLORS = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

export function syncThemeColorToRailBackground(
  doc: Document = document,
  readStyle: typeof getComputedStyle = getComputedStyle,
) {
  // The server rail is transparent, so the body's painted background is its
  // visible background. Reading the computed value keeps this in sync with CSS.
  const backgroundColor = readStyle(doc.body).backgroundColor.trim();
  if (!backgroundColor || TRANSPARENT_COLORS.has(backgroundColor)) return;

  let themeColorMetas = Array.from(
    doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  );

  if (themeColorMetas.length === 0) {
    const themeColorMeta = doc.createElement("meta");
    themeColorMeta.name = "theme-color";
    doc.head.appendChild(themeColorMeta);
    themeColorMetas = [themeColorMeta];
  }

  for (const themeColorMeta of themeColorMetas) {
    if (themeColorMeta.content !== backgroundColor) {
      themeColorMeta.content = backgroundColor;
    }
  }
}

export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();

  useEffect(() => {
    if (!resolvedTheme) return;

    let frame: number | null = null;
    const scheduleSync = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        syncThemeColorToRailBackground();
      });
    };

    syncThemeColorToRailBackground();
    scheduleSync();

    // Next can replace viewport metadata during client navigation, including a
    // query-only mobile pane change where usePathname() does not change.
    const observer = new MutationObserver(() => {
      scheduleSync();
    });
    observer.observe(document.head, {
      attributes: true,
      attributeFilter: ["content", "media"],
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [pathname, resolvedTheme]);

  return null;
}
