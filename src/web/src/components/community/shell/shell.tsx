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
      className={cn("fixed inset-0 flex overflow-hidden font-sans text-sm text-foreground", className)}
    >
      <AppBackground />
      {children}
    </div>
  )
}
