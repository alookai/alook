import type React from "react"
import { AppBackground } from "@/components/ui/app-surface"
import { cn } from "@/lib/utils"

type ShellProps = React.ComponentPropsWithoutRef<"div"> & {
  onNavigationIntent?: () => void
}

export function Shell({
  children,
  className,
  onNavigationIntent,
  onClickCapture,
  onKeyDownCapture,
  ...props
}: ShellProps) {
  return (
    <div
      {...props}
      onClickCapture={(event) => {
        onNavigationIntent?.()
        onClickCapture?.(event)
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" || event.key === " ") onNavigationIntent?.()
        onKeyDownCapture?.(event)
      }}
      className={cn("fixed inset-0 flex overflow-hidden font-sans text-sm text-foreground", className)}
    >
      <AppBackground />
      {children}
    </div>
  )
}
