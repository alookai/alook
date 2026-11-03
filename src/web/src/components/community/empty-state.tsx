import type { LucideIcon } from "lucide-react"

// Empty state — holds the frame, teaches what goes here (DESIGN.md).
export function EmptyState({ icon: Icon, label, description }: { icon: LucideIcon; label: string; description?: string }) {
  return (
    <div data-slot="empty-state" className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
      <div data-slot="empty-state-icon" className="grid size-14 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-7" />
      </div>
      <p className="max-w-65 text-sm text-muted-foreground">{label}</p>
      {description ? <p className="-mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground/80">{description}</p> : null}
    </div>
  )
}
