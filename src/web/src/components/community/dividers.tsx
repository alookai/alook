// Date divider — centered label on a hairline.
export function DateDivider({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground" suppressHydrationWarning>{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

// "NEW" unread divider — sits before the first unread message.
export function NewDivider() {
  return (
    <div className="my-1 flex items-center gap-2">
      <div className="h-px flex-1 bg-destructive/60" />
      <span className="rounded-sm bg-destructive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive-foreground">New</span>
    </div>
  )
}
