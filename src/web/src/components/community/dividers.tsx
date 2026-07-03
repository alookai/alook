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
  return (
    <div className="my-1 flex items-center gap-2">
      <Separator className="flex-1 bg-destructive/60" />
      <span className="rounded-sm bg-destructive px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-destructive-foreground">New</span>
    </div>
  )
}
