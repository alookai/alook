"use client";

import { Toaster } from "sonner";
import { useTheme } from "next-themes";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "@/components/icons/lucide";
import { useIsMobile } from "@/hooks/use-mobile";

export function ToasterProvider() {
  const { resolvedTheme } = useTheme();
  const isMobile = useIsMobile();

  return (
    <Toaster
      theme={(resolvedTheme as "light" | "dark") ?? "system"}
      closeButton
      position={isMobile ? "top-center" : "bottom-right"}
      icons={{
        success: <CircleCheckIcon isAnimated={false} className="size-4" />,
        info: <InfoIcon isAnimated={false} className="size-4" />,
        warning: <TriangleAlertIcon isAnimated={false} className="size-4" />,
        error: <OctagonXIcon isAnimated={false} className="size-4" />,
        loading: <Loader2Icon isAnimated={false} className="size-4 animate-spin motion-reduce:animate-none" />,
        close: <XIcon isAnimated={false} className="size-3.5" />,
      }}
      offset={{ top: "calc(var(--app-safe-area-top) + 32px)", right: "calc(var(--app-safe-area-right) + 32px)", bottom: "calc(var(--app-safe-area-bottom) + 32px)", left: "calc(var(--app-safe-area-left) + 32px)" }}
      mobileOffset={{ top: "calc(var(--app-safe-area-top) + 16px)", right: "calc(var(--app-safe-area-right) + 16px)", bottom: "calc(var(--app-safe-area-bottom) + 16px)", left: "calc(var(--app-safe-area-left) + 16px)" }}
    />
  );
}
