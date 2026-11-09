import type React from "react"
import { AppBackground } from "@/components/ui/app-surface"
import { cn } from "@/lib/utils"

type ShellProps = React.ComponentPropsWithoutRef<"div"> & {
  edgePaint?: boolean
  fullViewport?: boolean
}

export function Shell({
  children,
  className,
  edgePaint = true,
  fullViewport = false,
  ...props
}: ShellProps) {
  return (
    <div
      {...props}
      className={cn(!fullViewport && "app-safe-viewport", "fixed inset-0 flex overflow-hidden font-sans text-sm text-foreground", className)}
    >
      {edgePaint && <div aria-hidden data-slot="community-safe-edge-paint" className="pointer-events-none fixed inset-0 -z-20 bg-(--app-edge-fade-color,var(--app-bg))" />}
      <AppBackground data-slot="community-frame-paint" className={fullViewport ? undefined : "app-safe-viewport"} />
      {children}
    </div>
  )
}
