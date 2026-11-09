"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";

const TRANSPARENT_COLORS = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

export function syncThemeColorToVisibleBackground(
  doc: Document = document,
  readStyle: typeof getComputedStyle = getComputedStyle,
) {
  const pathname = doc.location?.pathname;
  let surface = pathname === "/c" || pathname?.startsWith("/c/")
    ? doc.querySelector<HTMLElement>('[data-community-startup-frame] [data-slot="community-frame-paint"]')
      ?? doc.querySelector<HTMLElement>('[data-slot="community-shell-root"] [data-community-mobile-surface]')
    : null;
  let backgroundColor = "";
  while (surface) {
    backgroundColor = readStyle(surface).backgroundColor.trim();
    if (backgroundColor && !TRANSPARENT_COLORS.has(backgroundColor)) break;
    surface = surface.parentElement;
  }
  if (!surface) backgroundColor = readStyle(doc.body).backgroundColor.trim();
  if (!backgroundColor || TRANSPARENT_COLORS.has(backgroundColor)) return;

  let changed = false;
  if (doc.body.style.getPropertyValue("--app-edge-fade-color") !== backgroundColor) {
    doc.body.style.setProperty("--app-edge-fade-color", backgroundColor);
    changed = true;
  }

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
      changed = true;
    }
  }
  if (changed) doc.defaultView?.dispatchEvent(new Event("alook:theme-color-change"));
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
        syncThemeColorToVisibleBackground();
      });
    };

    syncThemeColorToVisibleBackground();
    scheduleSync();

    const observer = new MutationObserver(() => {
      scheduleSync();
    });
    observer.observe(document.head, {
      attributes: true,
      attributeFilter: ["content", "media"],
      childList: true,
      subtree: true,
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-community-mobile-surface", "data-community-startup-frame"],
    });

    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [pathname, resolvedTheme]);

  return null;
}
