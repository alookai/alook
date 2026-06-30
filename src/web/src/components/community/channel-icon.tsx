import { cn } from "@/lib/utils"

export function ChannelIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="5 0 14 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("h-[1em] w-auto shrink-0", className)}
    >
      <line x1="16" y1="4" x2="8" y2="20" />
    </svg>
  )
}
