import type React from "react"
import type { LucideIcon } from "lucide-react"
import { ChevronLeft } from "lucide-react"

// Right-panel chrome (header + scroll body) shared by members / pinned / search / threads.
// Rendered inside a Sheet — the Sheet provides the outer frame (rounded card, bg, close
// button), so this component only contributes the in-content header and the scroll body.
// Returns a Fragment so SheetContent's rounded corners aren't covered by a square wrapper.
export function PanelShell({
  icon: Icon, title, children, bodyClassName = "p-4", onBack,
}: {
  icon: LucideIcon
  title: string
  children: React.ReactNode
  bodyClassName?: string
  onBack?: () => void
}) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-4">
        {onBack ? (
          <button onClick={onBack} className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Back to threads">
            <ChevronLeft className="size-4" />
          </button>
        ) : (
          <Icon className="size-4 text-muted-foreground" />
        )}
        <h2 className="flex-1 truncate text-base font-semibold">{title}</h2>
      </header>
      <div className={`flex-1 overflow-y-auto thin-scrollbar ${bodyClassName}`}>{children}</div>
    </>
  )
}
