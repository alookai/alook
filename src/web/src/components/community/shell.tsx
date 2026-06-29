import type React from "react"
import { AppBackground } from "@/components/ui/app-surface"

export function Shell({ children }: {
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 flex overflow-hidden font-sans text-sm text-foreground">
      <AppBackground />
      {children}
    </div>
  )
}
