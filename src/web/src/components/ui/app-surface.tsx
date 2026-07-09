import * as React from "react"
import { cn } from "@/lib/utils"

function AppBackground({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-(--app-bg)",
        className,
      )}
      {...props}
    />
  )
}

function AppSurface({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "flex-1 min-h-0 rounded-xl bg-card shadow-(--e1) ring-1 ring-border/40 overflow-hidden flex flex-col",
        className,
      )}
      {...props}
    />
  )
}

function AppRail({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="Navigation"
      className={cn(
        "flex h-full w-14 flex-col items-center pt-1 pb-2 gap-1",
        className,
      )}
      {...props}
    />
  )
}

export { AppBackground, AppSurface, AppRail }
