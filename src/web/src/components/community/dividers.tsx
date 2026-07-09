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

export function NewDivider() {
  // The row's height tracks the separator line only; the "New" pill is taken
  // out of flow so its taller box doesn't push messages apart.
  return (
    <div className="relative my-1 flex items-center">
      <Separator className="flex-1 bg-destructive/60" />
      <span
        className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 rounded-sm bg-destructive px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white"
        style={{ WebkitTextStroke: "0.4px currentColor" }}
      >
        New
      </span>
    </div>
  )
}
