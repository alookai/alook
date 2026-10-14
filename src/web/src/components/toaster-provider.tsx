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
      offset={isMobile ? { top: "calc(env(safe-area-inset-top) + 16px)" } : undefined}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 16px)" }}
    />
  );
}
