import type React from "react"
import { AppBackground } from "@/components/ui/app-surface"
import { cn } from "@/lib/utils"

type ShellProps = React.ComponentPropsWithoutRef<"div">

export function Shell({
  children,
  className,
  ...props
}: ShellProps) {
  return (
    <div
      {...props}
      className={cn("app-safe-viewport fixed flex overflow-hidden font-sans text-sm text-foreground", className)}
    >
      <div aria-hidden data-slot="community-safe-edge-paint" className="pointer-events-none fixed inset-0 -z-20 bg-(--app-edge-fade-color,var(--app-bg))" />
      <AppBackground className="app-safe-viewport" />
      {children}
    </div>
  )
}
