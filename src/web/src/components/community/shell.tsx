import type React from "react"
import { AppBackground } from "@/components/ui/app-surface"
import { cn } from "@/lib/utils"

export function Shell({ children, className }: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("fixed inset-0 flex overflow-hidden font-sans text-sm text-foreground", className)}>
      <AppBackground />
      {children}
    </div>
  )
}
