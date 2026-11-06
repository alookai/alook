import type React from "react"
import { AppBackground } from "@/components/ui/app-surface"
import { cn } from "@/lib/utils"

type ShellProps = React.ComponentPropsWithoutRef<"div"> & {
  edgePaint?: boolean
}

export function Shell({
  children,
  className,
  edgePaint = true,
  ...props
}: ShellProps) {
  return (
    <div
      {...props}
      className={cn("app-safe-viewport fixed flex overflow-hidden font-sans text-sm text-foreground", className)}
    >
      {edgePaint && <div aria-hidden data-slot="community-safe-edge-paint" className="pointer-events-none fixed inset-0 -z-20 bg-(--app-edge-fade-color,var(--app-bg))" />}
      <AppBackground data-slot="community-frame-paint" className="app-safe-viewport" />
      {children}
    </div>
  )
}
