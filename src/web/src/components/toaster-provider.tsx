"use client";

import { Toaster } from "sonner";
import { useTheme } from "next-themes";
import { useIsMobile } from "@/hooks/use-mobile";

export function ToasterProvider() {
  const { resolvedTheme } = useTheme();
  const isMobile = useIsMobile();

  return (
    <Toaster
      theme={(resolvedTheme as "light" | "dark") ?? "system"}
      richColors
      closeButton
      position={isMobile ? "top-center" : "bottom-right"}
      offset={{ top: "calc(var(--app-safe-area-top) + 32px)", right: "calc(var(--app-safe-area-right) + 32px)", bottom: "calc(var(--app-safe-area-bottom) + 32px)", left: "calc(var(--app-safe-area-left) + 32px)" }}
      mobileOffset={{ top: "calc(var(--app-safe-area-top) + 16px)", right: "calc(var(--app-safe-area-right) + 16px)", bottom: "calc(var(--app-safe-area-bottom) + 16px)", left: "calc(var(--app-safe-area-left) + 16px)" }}
    />
  );
}
