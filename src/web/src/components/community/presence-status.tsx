import { cn } from "@/lib/utils"

/** The one Online / Offline / unknown status pill (machines, bots, pairing). */
export function PresenceStatus({ online, known = true, label, className }: { online: boolean; known?: boolean; label: string; className?: string }) {
  return (
    <span
      data-slot="presence-status"
      data-online={online || undefined}
      data-presence={!known ? "unknown" : online ? "online" : "offline"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium",
        online ? "bg-status-online/15 text-approval-pass dark:text-status-online" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <span className={cn("inline-block size-1.5 rounded-full", online ? "bg-status-online" : known ? "bg-status-offline" : "bg-muted-foreground")} />
      {label}
    </span>
  )
}
