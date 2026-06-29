import { cn } from "@/lib/utils"

export function ChannelIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center font-medium leading-none", className)}>
      /
    </span>
  )
}
