import { Separator } from "@/components/ui/separator"

export function DateDivider({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-2">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground" suppressHydrationWarning>{label}</span>
      <Separator className="flex-1" />
    </div>
  )
}

export function NewDivider({ dateLabel }: { dateLabel?: string }) {
  // The row's height tracks the separator line only; the "New" pill is taken
  // out of flow so its taller box doesn't push messages apart.
  // `data-new-divider` lets `useScrollAnchor`'s mount effect center on this
  // element itself via `querySelector`, instead of the whole message row
  // (date divider + full message content) that used to be the only
  // `[data-msg-id]`-selectable target — see use-scroll-anchor.ts.
  // When the unread boundary lands on the first message of a new day, the
  // date label merges onto the same red line (centered) instead of rendering
  // a separate date-divider row above it.
  return (
    <div data-new-divider className="relative my-1 flex items-center gap-2">
      <Separator className="flex-1 bg-destructive/60" />
      {dateLabel && (
        <span className="text-xs font-semibold text-destructive" suppressHydrationWarning>{dateLabel}</span>
      )}
      <Separator className="flex-1 bg-destructive/60" />
      <span
        className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 rounded-sm bg-destructive px-1.5 py-0.5 text-xs font-semibold text-white"
        style={{ WebkitTextStroke: "0.4px currentColor" }}
      >
        New
      </span>
    </div>
  )
}
