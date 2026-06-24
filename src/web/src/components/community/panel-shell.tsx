import type React from "react"
import type { LucideIcon } from "lucide-react"
import { ChevronLeft, X } from "lucide-react"

// Right-panel chrome (header + scroll body) shared by members / pinned / search / threads.
export function PanelShell({
  icon: Icon, title, onClose, showClose, children, bodyClassName = "p-3", onBack,
}: {
  icon: LucideIcon
  title: string
  onClose: () => void
  showClose?: boolean
  children: React.ReactNode
  bodyClassName?: string
  onBack?: () => void
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {onBack ? (
          <button onClick={onBack} className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Back to threads">
            <ChevronLeft className="size-5" />
          </button>
        ) : (
          <Icon className="size-5 text-muted-foreground" />
        )}
        <h2 className="flex-1 truncate text-lg font-semibold">{title}</h2>
        {showClose && (
          <button onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close panel">
            <X className="size-4" />
          </button>
        )}
      </header>
      <div className={`flex-1 overflow-y-auto thin-scrollbar ${bodyClassName}`}>{children}</div>
    </div>
  )
}
